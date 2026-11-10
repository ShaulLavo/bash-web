export function pythonWaitTask(callback: unknown): string {
  if (typeof callback !== "function")
    throw new Error("Expected original Python readiness callback");
  return `await new Promise((resolve, reject) => {
  const signal = window.__pythonAdapterSignal;
  if (!signal) throw new Error("Missing Python case lifetime");
  let frame;
  function complete(result) {
    if (frame !== undefined) cancelAnimationFrame(frame);
    signal.removeEventListener("abort", aborted);
    if (result.status === "fail") { reject(result.error); return; }
    resolve();
  }
  function aborted() { complete({status:"fail",error:signal.reason}); }
  function sample() {
    if (signal.aborted) { aborted(); return; }
    let value;
    try { value = (${callback.toString()})(); }
    catch (error) { complete({status:"fail",error}); return; }
    if (value) { complete({status:"pass"}); return; }
    frame = requestAnimationFrame(sample);
  }
  signal.addEventListener("abort", aborted, {once:true});
  sample();
});`;
}
