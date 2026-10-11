import { describe, expect, it } from "vitest";
import { withTimeout } from "../src/utils/async.js";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("withTimeout", () => {
  it("resolves when the promise wins", async () => {
    const result = await withTimeout(Promise.resolve("fast"), 1_000, () => new Error("timeout"));
    expect(result).toBe("fast");
  });

  it("rejects with the provided error when time runs out", async () => {
    await expect(
      withTimeout(delay(500).then(() => "slow"), 10, () => new Error("deadline hit")),
    ).rejects.toThrow("deadline hit");
  });

  it("lets already-resolved promises win even with a zero timeout", async () => {
    const result = await withTimeout(Promise.resolve(42), 0, () => new Error("timeout"));
    expect(result).toBe(42);
  });

  it("propagates non-timeout rejections from the original promise", async () => {
    await expect(withTimeout(Promise.reject(new Error("inner")), 1_000, () => new Error("timeout"))).rejects.toThrow(
      "inner",
    );
  });
});
