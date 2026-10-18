// Oils spec tests call two small Python 2 helpers. Every engine gets the same behavior:
// bash runs these files, and the in-process engines register equivalent builtins.

export const pythonHelpers = {
  "argv.py": `#!/usr/bin/env python3
import os, sys
def r(b):
    q = '"' if b"'" in b and b'"' not in b else "'"
    out = q
    for c in b:
        if c == 0x5c: out += "\\\\\\\\"
        elif c == 0x0a: out += "\\\\n"
        elif c == 0x0d: out += "\\\\r"
        elif c == 0x09: out += "\\\\t"
        elif c == 0x27 and q == "'": out += "\\\\'"
        elif 0x20 <= c < 0x7f: out += chr(c)
        else: out += "\\\\x%02x" % c
    return out + q
sys.stdout.write("[" + ", ".join(r(os.fsencode(a)) for a in sys.argv[1:]) + "]\\n")
`,
  "printenv.py": `#!/usr/bin/env python3
import os, sys
for name in sys.argv[1:]:
    value = os.environb.get(os.fsencode(name))
    sys.stdout.buffer.write((value if value is not None else b"None") + b"\\n")
`,
};
