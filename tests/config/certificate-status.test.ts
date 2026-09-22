import { describe, expect, it } from "vitest";

import {
  RENEWAL_WARNING_DAYS,
  certificateStatus,
  parseAppleWalletConfig
} from "../../src/config/apple-wallet.config";
import { TEST_PASS_TYPE_IDENTIFIER, TEST_TEAM_IDENTIFIER } from "../helpers/test-certificates";

/**
 * The global setup exports a generated chain into the environment, so this reads the
 * same configuration the server would.
 */
const config = () => parseAppleWalletConfig(process.env);

const daysFromNow = (days: number): Date => new Date(Date.now() + days * 86_400_000);

describe("certificateStatus", () => {
  it("reports the identifiers the certificate itself carries", () => {
    const status = certificateStatus(new Date(), config());

    // Read off the subject, never configured — which is what makes swapping a
    // certificate a configuration change rather than a code change.
    expect(status.passTypeIdentifier).toBe(TEST_PASS_TYPE_IDENTIFIER);
    expect(status.teamIdentifier).toBe(TEST_TEAM_IDENTIFIER);
  });

  it("reports a validity window, not just an expiry", () => {
    const status = certificateStatus(new Date(), config());

    expect(status.validFrom.getTime()).toBeLessThanOrEqual(status.validTo.getTime());
  });

  it("counts down as the expiry approaches", () => {
    const loaded = config();
    const status = certificateStatus(new Date(), loaded);
    const tomorrow = certificateStatus(daysFromNow(1), loaded);

    expect(tomorrow.daysRemaining).toBe(status.daysRemaining - 1);
  });

  it("goes negative once expired rather than clamping at zero", () => {
    const loaded = config();
    const wellPast = certificateStatus(daysFromNow(400), loaded);

    // An expired certificate is a state worth being able to report. Clamping would make
    // "expired yesterday" and "expires today" look identical in a log.
    expect(wellPast.daysRemaining).toBeLessThan(0);
    expect(wellPast.expiresSoon).toBe(true);
  });

  it("raises the warning flag inside the renewal window", () => {
    const loaded = config();
    const status = certificateStatus(new Date(), loaded);
    const justInsideWindow = certificateStatus(
      new Date(status.validTo.getTime() - (RENEWAL_WARNING_DAYS - 1) * 86_400_000),
      loaded
    );

    expect(justInsideWindow.expiresSoon).toBe(true);
  });

  it("does not raise it outside the window", () => {
    const loaded = config();
    const status = certificateStatus(new Date(), loaded);
    const wellBefore = certificateStatus(
      new Date(status.validTo.getTime() - (RENEWAL_WARNING_DAYS + 5) * 86_400_000),
      loaded
    );

    expect(wellBefore.expiresSoon).toBe(false);
  });

  it("floors the count, so zero means today rather than some time yesterday", () => {
    const loaded = config();
    const status = certificateStatus(new Date(), loaded);

    // Eleven hours before expiry is still "today", not "-1". A ceiling here would round
    // an almost-dead certificate up to a day it does not have.
    const elevenHoursLeft = certificateStatus(
      new Date(status.validTo.getTime() - 11 * 3_600_000),
      loaded
    );

    expect(elevenHoursLeft.daysRemaining).toBe(0);
    expect(Number.isInteger(status.daysRemaining)).toBe(true);
  });
});
