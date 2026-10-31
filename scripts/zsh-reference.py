"""Observe zsh 5.9 ZLE in owned PTYs. Run on macOS with /bin/zsh; no GUI or user config."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

KEYS = {"cmd-left": "01", "cmd-right": "05", "left": "1b5b44", "right": "1b5b43",
        "up": "1b5b41", "down": "1b5b42", "ctrl-p": "10", "ctrl-n": "0e",
        "ss3-up": "1b4f41", "ss3-down": "1b4f42"}
HISTORY = ["# older\n# older tail", "# newer"]


def key(name):
    return {"key": name, "inputHex": KEYS[name]}


def paste(text):
    return {"key": "paste", "inputHex": ("\x1b[200~" + text + "\x1b[201~").encode().hex()}


def cases():
    return [
        ("line-bounds", [paste("first\n\nmiddle\nlast")] + [key(k) for k in ["cmd-left", "up", "cmd-right", "down", "cmd-right"]]),
        ("empty-lines", [paste("\n\n\n")] + [key(k) for k in ["up", "up", "up", "down", "down", "down"]]),
        ("sticky-column", [paste("abcdefgh\nx\nabcdef\n12345")] + [key(k) for k in ["up", "up", "up", "down", "down", "down"]]),
        ("history-edges", [paste("draft\n\nend")] + [key(k) for k in ["up", "up", "up", "up", "down", "down", "down", "down", "down"]]),
        ("history-middle", [paste("first\nmiddle\nlast"), key("up"), key("up"), key("up"), key("down"), key("down")]),
        ("soft-wrap", [paste("0123456789" * 8)] + [key(k) for k in ["cmd-left", "cmd-right", "up", "down"]]),
        ("unicode", [paste("中é🙂ab\n短\n中é🙂ab")] + [key(k) for k in ["up", "up", "down", "down", "cmd-left", "right", "up", "up", "down", "down"]]),
        ("controls", [paste("first\n\nlast")] + [key(k) for k in ["ctrl-p", "ctrl-p", "ctrl-n", "ctrl-n", "ss3-up", "ss3-down"]]),
        ("wide-target", [paste("中a\n12345")] + [key(k) for k in ["cmd-left", "right", "up", "down", "right", "up", "down"]]),
        ("tabs", [paste("a\tb\n123456789012\n\tend")] + [key(k) for k in ["cmd-left", "right", "up", "up", "down", "down"]]),
        ("combining-target", [paste("éabc\n12345")] + [key(k) for k in ["cmd-left", "right", "up", "down", "right", "up", "down"]]),
        ("edit-reset", [paste("abcdef\nx\n12345"), key("up"), {"key": "insert", "inputHex": "21"}, key("up"), key("down"), paste("?"), key("up")]),
        ("reset-column", [paste("abcdefgh\nx\n12345")] + [key(k) for k in ["up", "left", "up", "down", "cmd-right", "up", "down"]]),
    ]


class Zle:
    def __init__(self, home, columns, history):
        self.home = Path(home)
        self.pending = b""
        rc = self.home / ".zshrc"
        rc.write_text("\n".join([
            "bindkey -e", "PROMPT='$ '; RPROMPT=; HISTFILE=/dev/null; HISTSIZE=100; SAVEHIST=0",
            "bindkey -L > $HOME/bindings", "fc -p /dev/null",
            *["print -s -- '" + item + "'" for item in history],
            "_observe() { print -rn -- $BUFFER > $HOME/buffer; print -r -- $CURSOR > $HOME/point; print -rn -- '\\x1e' }",
            "zle -N zle-line-pre-redraw _observe",
        ]) + "\n")
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            env = {"PATH": "/usr/bin:/bin", "HOME": home, "ZDOTDIR": home,
                   "TERM": "xterm-256color", "LC_ALL": "en_US.UTF-8"}
            os.execve("/bin/zsh", ["/bin/zsh", "-d", "-i"], env)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, columns, 0, 0))

    def observe(self, data=b""):
        if data:
            os.write(self.master, data)
        deadline = time.monotonic() + 5
        # Redraw may be coalesced across all bytes sent in this event.
        while time.monotonic() < deadline:
            ready, _, _ = select.select([self.master], [], [], 0.05)
            if ready:
                self.pending += os.read(self.master, 65536)
                continue
            if b"\\x1e" in self.pending:
                self.pending = b""
                line = (self.home / "buffer").read_text()
                cursor = int((self.home / "point").read_text())
                return {"line": line, "point": len(line[:cursor].encode()), "scalarPoint": cursor}
        raise TimeoutError("ZLE observation timed out: " + repr(self.pending))

    def close(self):
        os.kill(self.pid, signal.SIGKILL)
        os.close(self.master)
        os.waitpid(self.pid, 0)


def run(home, events, columns, history):
    reference = Zle(home, columns, history)
    try:
        assert reference.observe(b"\x0c")["line"] == ""
        return [dict(event, **reference.observe(bytes.fromhex(event["inputHex"]))) for event in events]
    finally:
        reference.close()


def verify_prefixes(root, index, events, steps, history):
    for end, step in enumerate(steps, 1):
        control = Path(root) / f"control-{index}-{end}"
        control.mkdir()
        combined = b"".join(bytes.fromhex(event["inputHex"]) for event in events[:end])
        observed = run(str(control), [{"key": "prefix", "inputHex": combined.hex()}], 24, history)[0]
        assert (observed["line"], observed["point"]) == (step["line"], step["point"]), (index, end, observed, step)


def capture(root, result):
    for index, (name, events) in enumerate(cases()):
        home = Path(root) / str(index)
        home.mkdir()
        history = HISTORY
        steps = run(str(home), events, 24, history)
        if index == 0:
            result["bindings"] = (home / "bindings").read_text()
        verify_prefixes(root, index, events, steps, history)
        result["cases"].append({"name": name, "columns": 24, "history": history, "steps": steps})


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--key-reference", type=Path, required=True,
                        help="Unchanged tests/terminal/readline-navigation.json with native Ghostty source receipts")
    args = parser.parse_args()
    source = json.loads(args.key_reference.read_text())
    assert all(value == source["keys"][name] for name, value in KEYS.items())
    version = subprocess.check_output(["/bin/zsh", "--version"], text=True).strip()
    assert version.startswith("zsh 5.9 "), version
    result = {"version": version, "sha256": hashlib.sha256(Path("/bin/zsh").read_bytes()).hexdigest(),
              "keymap": "emacs", "locale": "en_US.UTF-8", "keys": KEYS,
              "ghosttyRevision": source["ghostty"]["revision"],
              "keyReferenceSha256": hashlib.sha256(args.key_reference.read_bytes()).hexdigest(),
              "observation": "zle-line-pre-redraw reads BUFFER and CURSOR without a diagnostic key binding. Every prefix also matches a fresh PTY. No fixture text is submitted.",
              "cases": []}
    signal.signal(signal.SIGTERM, interrupted)
    with tempfile.TemporaryDirectory(prefix="zsh-reference-", dir=args.output.parent) as root:
        capture(root, result)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"Observed {sum(len(c['steps']) for c in result['cases'])} states; fresh PTY prefix controls passed; all children reaped")


if __name__ == "__main__":
    main()
