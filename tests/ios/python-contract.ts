export const pythonCaseInventory = [
  {
    id: "PY01",
    label:
      "real CPython on Waffle loads once, runs scripts, disposes and leaves its borrowed runtime usable",
  },
  {
    id: "PY02",
    label: "disposing Python before first use fetches no payload and stops no caller runtime",
  },
] as const;

export type PythonCaseId = (typeof pythonCaseInventory)[number]["id"];
export interface PythonRequest {
  id: PythonCaseId;
}
