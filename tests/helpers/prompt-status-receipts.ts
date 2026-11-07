import { expect } from "@playwright/test";

export function checkPromptStatusReceipts(receipts: unknown): void {
  expect(receipts).toEqual([
    { generation: "1", status: 0 },
    { generation: "2", status: 1 },
    { generation: "3", status: 0 },
    { generation: "4", status: 1 },
    { generation: "5", status: 0 },
  ]);
}
