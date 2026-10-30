"""Observe default Bash Readline through a private PTY. Never submit fixture text."""
import argparse
import ctypes
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

DIAGNOSTIC = b"\x18\x07"
BASH = "/usr/bin/bash"
HISTORY = ["printf 'HISTORY_OLDER\\n'", "printf 'HISTORY_NEWER\\n'"]
KEYS = {
    "cmd-left": "01", "cmd-right": "05", "ctrl-a": "01", "ctrl-e": "05",
    "left": "1b5b44", "right": "1b5b43", "up": "1b5b41", "down": "1b5b42",
    "ctrl-p": "10", "ctrl-n": "0e", "option-left": "1b62", "option-right": "1b66",
    "option-up": "1b5b313b3341", "option-down": "1b5b313b3342",
    "shift-left": "1b5b313b3244", "shift-right": "1b5b313b3243",
    "shift-up": "1b5b313b3241", "shift-down": "1b5b313b3242",
    "shift-enter": "1b5b32373b323b31337e",
    "home": "1b5b48", "end": "1b5b46", "ss3-up": "1b4f41", "ss3-down": "1b4f42",
}


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def event(name, text=None):
    if text is not None:
        return {"key": name, "inputHex": text.encode().hex()}
    return {"key": name, "inputHex": KEYS[name]}


def paste(text):
    return event("bracketed-paste", "\x1b[200~" + text + "\x1b[201~")


def cases():
    markdown = "# Document\n\nA short paragraph.\n\n" * 3 + "## Last heading\n\nA final paragraph.\n"
    motions = [event(key) for key in ["cmd-left", "cmd-right", "left", "ctrl-a", "ctrl-e", "home", "end"]]
    history = [event(key) for key in ["up", "up", "up", "down", "down", "down"]]
    return [
        ("observer-unit-control", [paste("a中🙂b")] + [event(key) for key in ["ctrl-a", "right", "right", "right", "right", "left", "ctrl-e", "left", "left", "left"]]),
        ("markdown-blank-lines", [paste(markdown)] + motions + history),
        ("empty-lines", [paste("\n\n\n")] + motions + history),
        ("unicode-wrap", [paste("中 é 🙂 " + "wide words " * 12 + "\n\n尾")] + motions + history),
        ("history-from-middle", [paste("first\n\nmiddle\nlast"), event("left"), event("left")] + history),
        ("history-from-start", [paste("first\n\nlast"), event("ctrl-a")] + history),
        ("history-control", [paste("one\n\ntwo")] + [event(key) for key in ["ctrl-p", "ctrl-p", "ctrl-p", "ctrl-n", "ctrl-n", "ctrl-n"]]),
        ("history-ss3", [paste("one\n\ntwo"), event("ss3-up"), event("ss3-down")]),
        ("words", [paste("one,two  café中!\n\nlast word")] + [event(key) for key in ["option-left", "option-left", "option-left", "option-right", "option-right", "option-right"]]),
        ("modified-arrows", [paste("one two\n\nthree")] + [event(key) for key in ["shift-left", "shift-right", "shift-up", "shift-down", "option-up", "option-down"]]),
        ("draft-edits", [paste("draft\n\nend"), event("up"), event("down"), event("ctrl-a"), event("insert", "# "), event("ctrl-e"), event("insert", " tail"), event("up"), event("down")]),
        ("feel-navigation", [paste("# heading\n\n# middle\n\n# tail"), event("cmd-left"), event("insert", "# START "), event("cmd-right"), event("insert", " END"), event("up"), event("up"), event("up"), event("down"), event("down"), event("down")]),
        ("shift-enter-policy", [event("insert", "# first"), event("shift-enter"), event("insert", "# second")]),
    ]


class Readline:
    def __init__(self, directory, columns):
        self.pending = b""
        self.terminal = bytearray()
        read_fd, write_fd = os.pipe()
        self.side = read_fd
        rc = Path(directory) / "input.bash"
        rc.write_text("\n".join([
            "set -o emacs", "PS1='$ '; PS2='> '; PROMPT_COMMAND=", "HISTFILE=/dev/null; HISTCONTROL=; HISTIGNORE=",
            "bind -p > \"$REFERENCE_HOME/bindings-before\"", "bind -v > \"$REFERENCE_HOME/variables\"",
            "_observe() { builtin printf '%s\\0%s\\0' \"$READLINE_POINT\" \"$READLINE_LINE\" >&" + str(write_fd) + "; }",
            "bind -x '\"\\C-x\\C-g\":_observe'",
            "bind -p > \"$REFERENCE_HOME/bindings-after\"", "bind -X > \"$REFERENCE_HOME/diagnostic-binding\"",
            "history -c",
        ]) + "\n")
        # Only these fixed, quoted history commands execute, never the event text.
        with rc.open("a") as file:
            for entry in HISTORY:
                file.write("history -s '" + entry.replace("'", "'\\''") + "'\n")
        self.pid, self.master = pty.fork()
        if self.pid == 0:
            os.close(read_fd)
            os.set_inheritable(write_fd, True)
            env = {"PATH": "/usr/bin", "HOME": directory, "REFERENCE_HOME": directory,
                   "INPUTRC": "/dev/null", "TERM": "xterm-ghostty", "LC_ALL": "C.UTF-8"}
            os.execve(BASH, [BASH, "--noprofile", "--rcfile", str(rc), "-i"], env)
        os.close(write_fd)
        fcntl.ioctl(self.master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, columns, 0, 0))

    def read(self):
        ready, _, _ = select.select([self.master, self.side], [], [], 0.1)
        for fd in ready:
            data = os.read(fd, 65536)
            if fd == self.side:
                self.pending += data
                continue
            self.terminal.extend(data)

    def observe(self, data=b""):
        os.write(self.master, data + DIAGNOSTIC)
        deadline = time.monotonic() + 5
        while self.pending.count(b"\0") < 2:
            if time.monotonic() >= deadline:
                raise TimeoutError("Readline observation timed out")
            self.read()
        point, line, self.pending = self.pending.split(b"\0", 2)
        readline_point = int(point)
        assert 0 <= readline_point <= len(line.decode()), (readline_point, line)
        prefix = line.decode()[:readline_point]
        point = len(prefix.encode())
        return {"line": line.decode(), "point": point, "readlinePoint": readline_point, "logicalRow": prefix.count("\n"),
                "scalarColumn": len(prefix.rsplit("\n", 1)[-1])}

    def close(self):
        os.kill(self.pid, signal.SIGTERM)
        os.close(self.master)
        os.close(self.side)
        os.waitpid(self.pid, 0)


def identity(pid):
    maps = Path(f"/proc/{pid}/maps").read_text()
    libraries = sorted({line.split()[-1] for line in maps.splitlines() if "/lib" in line})
    readline = next(path for path in libraries if "libreadline.so" in path)
    lib = ctypes.CDLL(readline)
    return {"bash": BASH, "bashVersion": subprocess.check_output([BASH, "--version"], text=True).splitlines()[0],
            "bashSha256": sha(BASH), "runtimeReadline": readline, "readlineSha256": sha(readline),
            "readlineVersion": ctypes.c_char_p.in_dll(lib, "rl_library_version").value.decode(),
            "readlineVersionHex": hex(ctypes.c_int.in_dll(lib, "rl_readline_version").value),
            "packages": subprocess.check_output(["pacman", "-Q", "bash", "readline"], text=True).splitlines(),
            "libraries": [{"path": path, "sha256": sha(path)} for path in libraries]}


def run_case(name, events, directory, result):
    with tempfile.TemporaryDirectory(prefix="readline-", dir=directory) as home:
        reference = Readline(home, 24)
        try:
            initial = reference.observe()
            if "identity" not in result:
                result["identity"] = identity(reference.pid)
                before = Path(home, "bindings-before").read_text()
                after = Path(home, "bindings-after").read_text()
                removed = set(before.splitlines()) - set(after.splitlines())
                added = set(after.splitlines()) - set(before.splitlines())
                assert added == set() and removed == {'"\\C-x\\C-g": abort'}, (removed, added)
                result["bindings"] = {"beforeSha256": sha(Path(home, "bindings-before")),
                                      "afterSha256": sha(Path(home, "bindings-after")), "functions": before,
                                      "variables": Path(home, "variables").read_text(),
                                      "diagnostic": Path(home, "diagnostic-binding").read_text()}
            assert initial["line"] == "" and initial["point"] == 0
            steps = []
            for entry in events:
                observed = reference.observe(bytes.fromhex(entry["inputHex"]))
                assert observed == reference.observe(), "diagnostic mutated line or point"
                steps.append(dict(entry, **observed))
            return {"name": name, "columns": 24, "history": HISTORY, "steps": steps,
                    "parity": name not in {"shift-enter-policy", "modified-arrows"}}
        finally:
            reference.close()


def source_receipt(directory):
    revision = subprocess.check_output(["git", "-C", str(directory), "rev-parse", "HEAD"], text=True).strip()
    assert revision == "7b11f3dca034d8d24369ad3856afe57946d7902a", revision
    files = {"src/config/Config.zig": [(6710, 6734), (7140, 7150), (7260, 7269), (7331, 7359)],
             "src/input/function_keys.zig": [(53, 69), (81, 86), (213, 214)],
             "src/input/key_encode.zig": [(342, 351)], "src/input/paste.zig": [(4, 6), (103, 106)]}
    receipts = []
    for path, ranges in files.items():
        content = subprocess.check_output(["git", "-C", str(directory), "show", f"{revision}:{path}"])
        assert content == Path(directory, path).read_bytes(), f"modified source: {path}"
        lines = content.decode().splitlines()
        receipts.append({"path": path, "sha256": hashlib.sha256(content).hexdigest(),
                         "excerpts": [{"first": start, "last": end, "text": "\n".join(lines[start-1:end])}
                                      for start, end in ranges]})
    return {"repository": "https://github.com/ghostty-org/ghostty", "revision": revision,
            "platform": "macOS defaults, no active selection", "protocol": "legacy, kitty flags 0; CSI normal and SS3 application cursor variants",
            "cmdUpDown": "consumed jump_to_prompt, no PTY bytes",
            "shiftArrows": "performable adjust_selection consumes if a selection exists; otherwise CSI 1;2 A/B/C/D",
            "optionUpDown": "CSI 1;3 A/B; optionLeftRight use default ESC b/f bindings",
            "bracketedPaste": {"mode": 2004, "startHex": "1b5b3230307e", "endHex": "1b5b3230317e"}, "files": receipts}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--ghostty-source", type=Path, required=True)
    args = parser.parse_args()
    result = {"schema": 1, "locale": "C.UTF-8", "inputrc": "/dev/null", "keymap": "emacs-standard",
              "terminal": "xterm-ghostty", "diagnosticHex": DIAGNOSTIC.hex(), "keys": KEYS,
              "historyObservation": "Unique seeded entry bytes identify recall; every line and byte point comes from bind -x.",
              "ghostty": source_receipt(args.ghostty_source), "cases": []}
    with tempfile.TemporaryDirectory(prefix="bash5-reference-", dir=args.output.parent) as directory:
        for name, events in cases():
            result["cases"].append(run_case(name, events, directory, result))
    control = result["cases"][0]
    raw = [step["readlinePoint"] for step in control["steps"]]
    byte = [step["point"] for step in control["steps"]]
    assert raw == [4, 0, 1, 2, 3, 4, 3, 4, 3, 2, 1], raw
    assert byte == [9, 0, 1, 4, 8, 9, 8, 9, 8, 4, 1], byte
    result["observerUnitControl"] = {"text": "a中🙂b", "rawReadlinePoints": raw, "utf8BytePoints": byte,
                                     "conclusion": "This Bash bind -x READLINE_POINT counts Unicode scalars, not UTF-8 bytes.",
                                     "mutationControl": "Every event followed by a second unchanged observation; all line/point/logical fields equal."}
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(f"Observed {sum(len(case['steps']) for case in result['cases'])} states in {len(result['cases'])} PTYs; all reaped")


if __name__ == "__main__":
    main()
