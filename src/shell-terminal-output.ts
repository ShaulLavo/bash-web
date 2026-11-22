// Adapted from brush-web shell-terminal-output.ts at a2a4e96.
// Original own-shell terminal presentation. Descriptor and pipe traffic stays byte-exact;
// only the final terminal attachment applies the TTY's output newline discipline.
const outputCapacity = 32768;

export class TerminalNewlines {
  private previousCR = false;
  private scratch?: Uint8Array;

  write(bytes: Uint8Array, output: (bytes: Uint8Array) => void): void {
    if (bytes.length === 0) return;
    let lf = bytes.indexOf(10);
    const previousCR = this.previousCR;
    this.previousCR = bytes[bytes.length - 1] === 13;
    if (lf === -1) {
      if (bytes.length <= outputCapacity) return output(bytes);
      for (let offset = 0; offset < bytes.length; offset += outputCapacity)
        output(bytes.subarray(offset, offset + outputCapacity));
      return;
    }

    const buffer = (this.scratch ??= new Uint8Array(outputCapacity));
    let count = 0;
    let start = 0;
    const flush = () => {
      const ready = buffer.slice(0, count);
      count = 0;
      output(ready);
    };
    const copyThrough = (end: number) => {
      while (start < end) {
        const length = Math.min(end - start, buffer.length - count);
        buffer.set(bytes.subarray(start, start + length), count);
        start += length;
        count += length;
        if (count === buffer.length) flush();
      }
    };
    for (; lf !== -1; lf = bytes.indexOf(10, lf + 1)) {
      if (lf === 0 ? previousCR : bytes[lf - 1] === 13) continue;
      copyThrough(lf);
      buffer[count++] = 13;
      if (count === buffer.length) flush();
    }
    copyThrough(bytes.length);
    if (count) flush();
  }
}
