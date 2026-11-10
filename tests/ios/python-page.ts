import type { HostCase, HostWorker } from "waffle/testing/page-runner";
import { PythonEvaluation } from "./python-evaluation";
import { pythonWaitTask } from "./python-wait";

export class PythonPage extends PythonEvaluation {
  private currentWorkers: readonly HostWorker[] = [];
  private readonly subscriptions: (() => Promise<void>)[] = [];
  private navigated = false;
  constructor(host: HostCase) {
    super(host);
  }
  on(event: string, callback: unknown): void {
    if (event !== "request" || typeof callback !== "function")
      throw new Error("Unexpected original Python browser listener");
    this.subscriptions.push(
      this.host.onRequest(async (url) => {
        await Reflect.apply(callback, undefined, [{ url: () => url }]);
      }),
    );
  }
  async refreshWorkers(): Promise<void> {
    this.currentWorkers = await this.host.workers();
  }
  workers(): readonly HostWorker[] {
    return this.currentWorkers;
  }
  async goto(path: string): Promise<void> {
    if (path !== "/python-tests.html" || this.navigated)
      throw new Error("Unexpected original Python fixture navigation");
    const actual = await this.host.script("return new URL(location.href).pathname;");
    if (actual !== path) throw new Error("Python fixture document binding changed");
    this.navigated = true;
    await this.host.task('await import("/python-tests.js");');
    await this.refreshWorkers();
  }
  async waitForFunction(callback: unknown): Promise<void> {
    await this.host.task(pythonWaitTask(callback));
    await this.refreshWorkers();
  }
  override async evaluate(callback: unknown, argument?: unknown): Promise<unknown> {
    const value = await super.evaluate(callback, argument);
    await this.refreshWorkers();
    return value;
  }
  async disposeRequests(): Promise<void> {
    await Promise.all(this.subscriptions.map((stop) => stop()));
  }
}
