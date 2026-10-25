# Builtin help

`help` describes bash-web's executable shell builtins. The command catalogue
supplies topic names and handlers. Keywords and external command add-ons are not
help topics.

- `help` lists the implemented builtins and identifies the shell as bash-web.
- `help name` prints the topic's synopsis and description.
- `help -s name` prints a synopsis on one line.
- `help -d name` prints a short description.
- `help -m name` prints a pseudo-manpage with bash-web as its implementation.
- `--` ends option processing. Combined flags use `-d`, then `-m`, then `-s`
  precedence regardless of their order.

Queries prefer an exact topic, then name prefixes, then shell wildcard patterns.
Multiple queries print in argument order. The status is 0 if any topic matches,
1 if none matches, and 2 for an invalid option or `--help`.

The descriptions and synopses document bash-web, not the full GNU Bash manual.
The GNU Bash version banner, platform identity, unsupported topics, and full
manual text are deliberately absent. The Oils full-help dump remains incompatible.
