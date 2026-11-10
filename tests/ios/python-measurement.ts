import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import type { PythonCaseId } from "./python-contract";
import { appendHostAttachments } from "./host-diagnostic-delivery";
import type { PythonTestInfo } from "./python-original";

interface MeasurementAttachment {
  name: string;
  contentType: string;
  path: string;
  bytes: number;
  sha256: string;
}
export class PythonMeasurement implements PythonTestInfo {
  readonly outputDir: string;
  readonly attachments: MeasurementAttachment[] = [];
  constructor(
    private readonly resultPath: string,
    private readonly caseId: PythonCaseId,
  ) {
    if (!isAbsolute(resultPath))
      throw new Error("Python measurement needs an absolute result path");
    this.outputDir = resolve(`${resultPath}.artifacts`, caseId);
  }
  outputPath(name: string): string {
    if (!name || basename(name) !== name) throw new Error("Invalid Python output file name");
    return resolve(this.outputDir, name);
  }
  async attach(name: string, options: { contentType: string; path: string }): Promise<void> {
    if (
      name !== "python-measurement" ||
      options.contentType !== "application/json" ||
      options.path !== this.outputPath("python-measurement-report.json")
    )
      throw new Error("Unexpected original Python attachment");
    const bytes = await readFile(options.path);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    await appendHostAttachments(this.resultPath, [
      { caseId: this.caseId, name, contentType: options.contentType, body },
    ]);
    this.attachments.push({
      name,
      contentType: options.contentType,
      path: options.path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
}
