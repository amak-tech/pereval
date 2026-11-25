import { describe, expect, it } from "vitest";
import { withTimeout } from "../index";

describe("jobs runner withTimeout", () => {
  it("resolves when task completes within timeout", async () => {
    const res = await withTimeout(
      new Promise<string>((resolve) => setTimeout(() => resolve("done"), 10)),
      100,
      "test-fast",
    );
    expect(res).toBe("done");
  });

  it("rejects with timeout error when task exceeds timeout", async () => {
    await expect(
      withTimeout(
        new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 100)),
        20,
        "test-slow",
      ),
    ).rejects.toThrow("[jobs] задача test-slow превысила таймаут 20ms");
  });
});
