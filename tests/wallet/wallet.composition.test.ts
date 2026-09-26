import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * These assert a deployment property rather than a unit's behaviour: that a
 * half-configured wallet subsystem degrades instead of taking the API down with it.
 *
 * Membership sign-up needs no wallet. Turning WALLET_SYNC_MODE on without also setting
 * CARD_REDEMPTION_SECRET used to throw at import, which turned a feature gap into an
 * outage of the one endpoint a clinic's QR poster points at.
 *
 * The config module reads process.env once at import, so each case re-imports it with
 * the environment it is describing.
 */
const withEnv = async <T>(
  overrides: Record<string, string | undefined>,
  run: (composition: typeof import("../../src/wallet/wallet.composition")) => Promise<T> | T
): Promise<T> => {
  const original = { ...process.env };

  // The base env src/config/env.ts requires at import. Supplied by the harness rather
  // than inherited, because mocking dotenv away leaves nothing behind it: the suite
  // would then pass only on CI, which sets these at job level, and fail on every
  // developer machine. A test that behaves differently in the two places is worse than
  // no test.
  Object.assign(process.env, {
    DATABASE_URL: "postgresql://voone:voone@localhost:5432/voone?schema=public",
    REDIS_URL: "redis://localhost:6379",
    PORT: "4000",
    FRONTEND_URL: "http://localhost:3000"
  });

  Object.entries(overrides).forEach(([key, value]) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  });

  vi.resetModules();
  // dotenv is mocked so a developer's .env cannot leak in and re-supply a variable this
  // harness is deliberately unsetting — without it, "CARD_REDEMPTION_SECRET is missing"
  // is untestable on any machine that has one.
  vi.doMock("dotenv", () => ({
    default: { config: vi.fn() },
    config: vi.fn()
  }));

  try {
    return await run(await import("../../src/wallet/wallet.composition"));
  } finally {
    vi.doUnmock("dotenv");
    process.env = original;
    vi.resetModules();
  }
};

const prisma = {} as never;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("wallet composition, when CARD_REDEMPTION_SECRET is missing", () => {
  const unset = { CARD_REDEMPTION_SECRET: undefined };

  it("reports itself unconfigured", async () => {
    await withEnv(unset, (composition) => {
      expect(composition.isWalletSyncConfigured()).toBe(false);
    });
  });

  it("does not consume the queue, and says so rather than crashing the API", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await withEnv(
      { ...unset, WALLET_SYNC_MODE: "queue", WALLET_WORKER_IN_PROCESS: "true" },
      (composition) => {
        // The trap: this used to throw at import and take sign-up down with it.
        expect(composition.startInProcessWalletWorker(prisma)).toBeNull();
        expect(warn).toHaveBeenCalledOnce();
        expect(String(warn.mock.calls[0][0])).toContain("CARD_REDEMPTION_SECRET");
      }
    );
  });

  it("builds no inline queue rather than throwing into whatever asked for one", async () => {
    await withEnv({ ...unset, WALLET_SYNC_MODE: "inline" }, (composition) => {
      expect(composition.buildWalletSyncQueue(prisma)).toBeNull();
    });
  });

  it("still throws if a caller skips the check, because that is a programming error", async () => {
    await withEnv(unset, (composition) => {
      expect(() => composition.buildWalletSyncService(prisma)).toThrow(/isWalletSyncConfigured/);
    });
  });
});

describe("wallet composition, when it is configured", () => {
  const configured = { CARD_REDEMPTION_SECRET: "a-server-secret-long-enough-to-pass" };

  it("reports itself configured", async () => {
    await withEnv(configured, (composition) => {
      expect(composition.isWalletSyncConfigured()).toBe(true);
    });
  });

  it("consumes nothing while the mode is inline", async () => {
    await withEnv({ ...configured, WALLET_SYNC_MODE: "inline" }, (composition) => {
      expect(composition.startInProcessWalletWorker(prisma)).toBeNull();
    });
  });

  it("consumes nothing when a dedicated worker has been given the job", async () => {
    await withEnv(
      { ...configured, WALLET_SYNC_MODE: "queue", WALLET_WORKER_IN_PROCESS: "false" },
      (composition) => {
        expect(composition.startInProcessWalletWorker(prisma)).toBeNull();
      }
    );
  });
});
