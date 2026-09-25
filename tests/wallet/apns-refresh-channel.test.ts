import { beforeEach, describe, expect, it, vi } from "vitest";

import { WalletProviderType } from "@prisma/client";

import { FakeRefreshChannel } from "../../src/wallet/engine/fake-refresh-channel";
import type { CardRef } from "../../src/wallet/engine/wallet-pass-provider.interface";
import { ApnsPassRefreshChannel } from "../../src/wallet/providers/apple/apns-refresh-channel";
import {
  isDeadToken,
  type ApnsClient,
  type ApnsResult
} from "../../src/wallet/providers/apple/apns.client";

const PASS_TYPE = "pass.ai.voone.giftcard";

const ref = (serial: string): CardRef => ({
  provider: WalletProviderType.APPLE,
  externalId: serial,
  memberId: `member-${serial}`
});

/** Only the two methods the channel actually reaches for. */
class Devices {
  tokens = new Map<string, string[]>();
  removedTokens: string[] = [];
  failFor: string | null = null;

  async pushTokensFor(passType: string, serial: string): Promise<string[]> {
    if (this.failFor === serial) throw new Error("database is down");
    if (passType !== PASS_TYPE) return [];
    return this.tokens.get(serial) ?? [];
  }

  async removeRegistrationsByPushToken(token: string): Promise<number> {
    this.removedTokens.push(token);
    let removed = 0;
    this.tokens.forEach((list, serial) => {
      const kept = list.filter((t) => t !== token);
      removed += list.length - kept.length;
      this.tokens.set(serial, kept);
    });
    return removed;
  }
}

class Client implements ApnsClient {
  sent: { token: string; topic: string }[] = [];
  reply: (token: string) => ApnsResult = () => ({ status: 200 });
  throwFor: string | null = null;

  async send(token: string, topic: string): Promise<ApnsResult> {
    this.sent.push({ token, topic });
    if (this.throwFor === token) throw new Error("socket exploded");
    return this.reply(token);
  }

  async close(): Promise<void> {}
}

describe("ApnsPassRefreshChannel", () => {
  let devices: Devices;
  let client: Client;
  let log: ReturnType<typeof vi.fn>;
  let channel: ApnsPassRefreshChannel;

  beforeEach(() => {
    devices = new Devices();
    client = new Client();
    log = vi.fn();
    channel = new ApnsPassRefreshChannel(
      client,
      devices as never,
      PASS_TYPE,
      log as unknown as (m: string) => void
    );
  });

  it("pushes to every device holding the pass, on the certificate's own topic", async () => {
    devices.tokens.set("card-1", ["tok-a", "tok-b"]);

    await channel.notifyRefresh([ref("card-1")]);

    expect(client.sent.map((s) => s.token).sort()).toEqual(["tok-a", "tok-b"]);
    expect(client.sent.every((s) => s.topic === PASS_TYPE)).toBe(true);
  });

  it("sends one push per device, not one per pass", async () => {
    // One phone holding three changed passes. The payload says only "something with this
    // pass type changed", so three pushes would be three identical wake-ups.
    devices.tokens.set("card-1", ["same-phone"]);
    devices.tokens.set("card-2", ["same-phone"]);
    devices.tokens.set("card-3", ["same-phone"]);

    await channel.notifyRefresh([ref("card-1"), ref("card-2"), ref("card-3")]);

    expect(client.sent).toHaveLength(1);
  });

  it("does nothing at all when no device has registered", async () => {
    await channel.notifyRefresh([ref("never-installed")]);

    expect(client.sent).toEqual([]);
  });

  it("touches nothing for an empty list", async () => {
    await channel.notifyRefresh([]);

    expect(client.sent).toEqual([]);
    expect(devices.removedTokens).toEqual([]);
  });

  it("forgets a token APNs reports as gone, so it is never pushed to again", async () => {
    devices.tokens.set("card-1", ["dead-token"]);
    client.reply = () => ({ status: 410, reason: "Unregistered" });

    await channel.notifyRefresh([ref("card-1")]);

    expect(devices.removedTokens).toEqual(["dead-token"]);
    expect(devices.tokens.get("card-1")).toEqual([]);
  });

  it("keeps a token that failed for a reason that might pass", async () => {
    devices.tokens.set("card-1", ["tok"]);
    // 429 is "slow down", not "this device is gone". Deleting here would unsubscribe a
    // live member because Apple was busy.
    client.reply = () => ({ status: 429, reason: "TooManyRequests" });

    await channel.notifyRefresh([ref("card-1")]);

    expect(devices.removedTokens).toEqual([]);
    expect(log).toHaveBeenCalled();
  });

  it("one dead device does not stop the others being woken", async () => {
    devices.tokens.set("card-1", ["dead", "alive"]);
    client.reply = (token) =>
      token === "dead" ? { status: 410, reason: "Unregistered" } : { status: 200 };

    await channel.notifyRefresh([ref("card-1")]);

    expect(client.sent.map((s) => s.token).sort()).toEqual(["alive", "dead"]);
    expect(devices.removedTokens).toEqual(["dead"]);
  });

  it("never throws when the transport does, because sync must not fail on a push", async () => {
    devices.tokens.set("card-1", ["boom"]);
    client.throwFor = "boom";

    // The card's real state is already published. A failed wake-up only means the member
    // waits for the device's own poll — marking the sync FAILED would be a lie.
    await expect(channel.notifyRefresh([ref("card-1")])).resolves.toBeUndefined();
    expect(log).toHaveBeenCalled();
  });

  it("still wakes the devices it could look up when one lookup fails", async () => {
    devices.tokens.set("card-1", ["good"]);
    devices.failFor = "card-2";

    await channel.notifyRefresh([ref("card-1"), ref("card-2")]);

    expect(client.sent.map((s) => s.token)).toEqual(["good"]);
  });
});

describe("isDeadToken", () => {
  it("treats 410 as gone for good", () => {
    expect(isDeadToken({ status: 410, reason: "Unregistered" })).toBe(true);
  });

  it("treats a malformed or foreign token as gone", () => {
    expect(isDeadToken({ status: 400, reason: "BadDeviceToken" })).toBe(true);
    expect(isDeadToken({ status: 400, reason: "DeviceTokenNotForTopic" })).toBe(true);
  });

  it("does not treat other 400s as gone", () => {
    // MissingTopic is our bug, not the device's. Deleting registrations over it would
    // turn a configuration mistake into permanent data loss.
    expect(isDeadToken({ status: 400, reason: "MissingTopic" })).toBe(false);
  });

  it("does not treat throttling or an outage as gone", () => {
    expect(isDeadToken({ status: 429, reason: "TooManyRequests" })).toBe(false);
    expect(isDeadToken({ status: 503, reason: "ServiceUnavailable" })).toBe(false);
    expect(isDeadToken({ status: 0, reason: "Timeout" })).toBe(false);
  });
});

describe("FakeRefreshChannel", () => {
  it("records what it would have woken", async () => {
    const fake = new FakeRefreshChannel();

    await fake.notifyRefresh([ref("a"), ref("b")]);
    await fake.notifyRefresh([ref("c")]);

    expect(fake.calls).toHaveLength(2);
    expect(fake.notifiedSerials).toEqual(["a", "b", "c"]);
  });

  it("resets", async () => {
    const fake = new FakeRefreshChannel();

    await fake.notifyRefresh([ref("a")]);
    fake.reset();

    expect(fake.calls).toEqual([]);
  });
});
