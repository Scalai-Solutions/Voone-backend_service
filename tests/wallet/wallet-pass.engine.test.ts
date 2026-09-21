import { describe, expect, it } from "vitest";

import { WalletPassDataError } from "../../src/common/errors/wallet.errors";
import { WalletPassEngine } from "../../src/wallet/engine/wallet-pass.engine";
import { aureaGoldPass } from "../fixtures/loyalty-card.fixture";

describe("WalletPassEngine", () => {
  const engine = new WalletPassEngine();

  it("builds a signed pass from valid data", async () => {
    const built = await engine.createPass("apple", aureaGoldPass);

    expect(built.contentType).toBe("application/vnd.apple.pkpass");
    expect(built.buffer.length).toBeGreaterThan(0);
  });

  it("rejects invalid data with a message that is safe to return to a caller", async () => {
    const attempt = engine.createPass("apple", { ...aureaGoldPass, points: -1 });

    await expect(attempt).rejects.toThrow(WalletPassDataError);
    await expect(attempt).rejects.toThrow(/points/);
  });

  it("accepts any tier string, since Member.tier is free text", async () => {
    const built = await engine.createPass("apple", { ...aureaGoldPass, tier: "Socia Fundadora" });

    expect(built.buffer.length).toBeGreaterThan(0);
  });

  it("reports validation errors as exposable, so a route may echo them", async () => {
    try {
      await engine.createPass("apple", {});
      expect.unreachable("expected a validation error");
    } catch (error) {
      expect((error as WalletPassDataError).expose).toBe(true);
      expect((error as WalletPassDataError).statusCode).toBe(422);
    }
  });

  it("does not pretend to support Google Wallet yet", async () => {
    await expect(engine.createPass("google", aureaGoldPass)).rejects.toThrow("Not implemented");
  });
});
