import { describe, expect, it, vi } from "vitest";

import { MAX_RECHECKS, nextRecheckDepth } from "../../src/wallet/engine/wallet-recheck";

describe("nextRecheckDepth", () => {
  it("asks for nothing when the sync was not stale", () => {
    expect(nextRecheckDepth("m1", false, 0)).toBeNull();
    expect(nextRecheckDepth("m1", false, MAX_RECHECKS)).toBeNull();
  });

  it("counts up from the depth the job carries", () => {
    expect(nextRecheckDepth("m1", true, 0)).toBe(1);
    expect(nextRecheckDepth("m1", true, 1)).toBe(2);
    expect(nextRecheckDepth("m1", true, 2)).toBe(3);
  });

  it("stops at the cap with a single warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(MAX_RECHECKS).toBe(3);
    expect(nextRecheckDepth("m1", true, 3)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[wallet] sync for member m1 still changing after 3 re-checks"
    );
  });
});
