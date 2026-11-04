import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";

import express from "express";
import { describe, expect, it } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler";
import { createGoogleWalletCallbackRouter } from "../../src/routes/v1/google-wallet-callback.route";
import {
  lengthPrefixed,
  verifyGoogleCallback,
  type GoogleRootKey
} from "../../src/wallet/providers/google/callback-verifier";

/**
 * Callbacks signed here exactly as Google signs them (ECv2SigningOnly), with locally generated
 * keys standing in for Google's root key and its intermediate key.
 */
const NOW = 1_800_000_000_000;
const ISSUER = "3388000000012345";
const ec = () => generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const spki = (key: KeyObject) => key.export({ format: "der", type: "spki" }).toString("base64");
const signB64 = (key: KeyObject, data: Buffer) => sign("sha256", data, key).toString("base64");

const root = ec();
const intermediate = ec();
const rootKeys: GoogleRootKey[] = [
  {
    keyValue: spki(root.publicKey),
    protocolVersion: "ECv2SigningOnly",
    keyExpiration: String(NOW + 1e9)
  }
];

const callback = (
  overrides: { message?: Record<string, unknown>; recipient?: string; keyExpiration?: number } = {}
) => {
  const signedKey = JSON.stringify({
    keyValue: spki(intermediate.publicKey),
    keyExpiration: String(overrides.keyExpiration ?? NOW + 1e9)
  });
  const signedMessage = JSON.stringify({
    classId: `${ISSUER}.class`,
    objectId: `${ISSUER}.member_1`,
    eventType: "save",
    nonce: "n-1",
    expTimeMillis: NOW + 60_000,
    ...overrides.message
  });

  return {
    protocolVersion: "ECv2SigningOnly",
    intermediateSigningKey: {
      signedKey,
      signatures: [
        signB64(root.privateKey, lengthPrefixed("GooglePayPasses", "ECv2SigningOnly", signedKey))
      ]
    },
    signedMessage,
    signature: signB64(
      intermediate.privateKey,
      lengthPrefixed(
        "GooglePayPasses",
        overrides.recipient ?? ISSUER,
        "ECv2SigningOnly",
        signedMessage
      )
    )
  };
};

describe("verifyGoogleCallback", () => {
  it("accepts a genuine, current callback and returns its message", () => {
    expect(verifyGoogleCallback(callback(), rootKeys, ISSUER, NOW)).toMatchObject({
      objectId: `${ISSUER}.member_1`,
      eventType: "save",
      nonce: "n-1"
    });
  });

  it("refuses a message altered after signing", () => {
    const body = callback();

    body.signedMessage = body.signedMessage.replace("member_1", "member_2");

    expect(verifyGoogleCallback(body, rootKeys, ISSUER, NOW)).toBeNull();
  });

  it("refuses a callback signed for another issuer", () => {
    expect(verifyGoogleCallback(callback({ recipient: "999" }), rootKeys, ISSUER, NOW)).toBeNull();
  });

  it("refuses an intermediate key no Google root key signed", () => {
    const stranger = ec();

    expect(
      verifyGoogleCallback(
        callback(),
        [{ keyValue: spki(stranger.publicKey), protocolVersion: "ECv2SigningOnly" }],
        ISSUER,
        NOW
      )
    ).toBeNull();
  });

  it("refuses an expired message, intermediate key or root key", () => {
    expect(
      verifyGoogleCallback(callback({ message: { expTimeMillis: NOW - 1 } }), rootKeys, ISSUER, NOW)
    ).toBeNull();
    expect(
      verifyGoogleCallback(callback({ keyExpiration: NOW - 1 }), rootKeys, ISSUER, NOW)
    ).toBeNull();
    expect(
      verifyGoogleCallback(
        callback(),
        [{ ...rootKeys[0], keyExpiration: String(NOW - 1) }],
        ISSUER,
        NOW
      )
    ).toBeNull();
  });

  it("returns null, never throws, for junk", () => {
    expect(verifyGoogleCallback({ hello: "world" }, rootKeys, ISSUER, NOW)).toBeNull();
    expect(verifyGoogleCallback(null, rootKeys, ISSUER, NOW)).toBeNull();
  });
});

describe("POST /google-wallet/callback", () => {
  const post = async (body: unknown, known = true) => {
    const synced: string[] = [];
    const welcomed: string[] = [];
    const app = express();

    app.use(express.json());
    app.use(
      createGoogleWalletCallbackRouter({
        prisma: {
          walletObject: { findFirst: async () => (known ? { memberId: "m1" } : null) }
        } as never,
        rootKeys: async () => rootKeys,
        issuerId: () => ISSUER,
        enqueueMemberSync: async (memberId) => void synced.push(memberId),
        welcome: async (memberId) => void welcomed.push(memberId)
      })
    );
    app.use(errorHandler);

    const server = app.listen(0);

    try {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const response = await fetch(`http://127.0.0.1:${port}/google-wallet/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

      return { status: response.status, synced, welcomed };
    } finally {
      server.close();
    }
  };

  // The route checks expiry against the real clock, so these callbacks expire far in the future.
  const live = (message: Record<string, unknown> = {}) =>
    callback({ message: { expTimeMillis: Date.now() + 60_000, ...message } });

  it("on a save, refreshes the card and sends the tier welcome", async () => {
    expect(await post(live())).toEqual({ status: 200, synced: ["m1"], welcomed: ["m1"] });
  });

  it("does nothing, and says 400, for an unsigned body", async () => {
    expect(await post({ signedMessage: "{}" })).toEqual({ status: 400, synced: [], welcomed: [] });
  });

  it("acknowledges a deletion or an unknown pass without acting, so Google does not retry", async () => {
    expect(await post(live({ eventType: "del" }))).toEqual({
      status: 200,
      synced: [],
      welcomed: []
    });
    expect(await post(live(), false)).toEqual({ status: 200, synced: [], welcomed: [] });
  });
});
