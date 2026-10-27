import express, { type Express } from "express";
import { describe, expect, it, vi } from "vitest";

import { errorHandler } from "../../src/common/middleware/error-handler";
import { config } from "../../src/config/env";
import type { CardIssuer } from "../../src/modules/wallet/card-issuer";
import { createMemberPassRouter } from "../../src/routes/v1/member-pass.route";

/**
 * A pass handed to a person is the first evidence it may be installed. Each route that
 * serves one stamps the download; a route that merely answers 404 or a link must not.
 */
const fileArtifact = {
  kind: "file" as const,
  buffer: Buffer.from("signed"),
  fileName: "card.pkpass",
  contentType: "application/vnd.apple.pkpass"
};

const buildApp = (
  options: { artifact?: unknown; claim?: string | null; recordFails?: boolean } = {}
) => {
  const recordAppleDownload = vi.fn(async (memberId: string) => {
    void memberId;
    if (options.recordFails) throw new Error("database is down");
  });

  const issuer = {
    artifactFor: async () => options.artifact ?? fileArtifact
  } as unknown as CardIssuer;

  const app: Express = express();

  app.use(
    "/api/v1",
    createMemberPassRouter({
      issuer,
      memberForClaim: async () => (options.claim === undefined ? "m-claim" : options.claim),
      memberExists: async (id) => id !== "m-gone",
      recordAppleDownload
    })
  );
  app.use(errorHandler);

  return { app, recordAppleDownload };
};

const get = async (app: Express, path: string, headers: Record<string, string> = {}) => {
  const server = app.listen(0);

  try {
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, { headers });

    return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
  } finally {
    server.close();
  }
};

const staff = (): Record<string, string> =>
  config.STAFF_API_KEY ? { "x-voone-staff-key": config.STAFF_API_KEY } : {};

describe("serving an Apple pass records the download", () => {
  it("stamps the member on the staff card download", async () => {
    const { app, recordAppleDownload } = buildApp();

    const reply = await get(app, "/members/m-1/pass/apple", staff());

    expect(reply.status).toBe(200);
    expect(reply.bytes.toString()).toBe("signed");
    expect(recordAppleDownload).toHaveBeenCalledWith("m-1");
  });

  it("stamps the member on the claim-link download", async () => {
    const { app, recordAppleDownload } = buildApp();

    const reply = await get(app, "/pass-claims/the-token");

    expect(reply.status).toBe(200);
    expect(recordAppleDownload).toHaveBeenCalledWith("m-claim");
  });

  it("stamps nothing when no pass was served", async () => {
    const unknownClaim = buildApp({ claim: null });
    const link = buildApp({ artifact: { kind: "link", url: "https://example.com/save" } });

    expect((await get(unknownClaim.app, "/pass-claims/nope")).status).toBe(404);
    expect((await get(link.app, "/pass-claims/the-token")).status).toBe(200);
    expect((await get(link.app, "/members/m-1/pass/apple", staff())).status).toBe(200);
    expect((await get(link.app, "/members/m-gone/pass/apple", staff())).status).toBe(404);

    expect(unknownClaim.recordAppleDownload).not.toHaveBeenCalled();
    expect(link.recordAppleDownload).not.toHaveBeenCalled();
  });

  it("still serves the pass when recording the download fails", async () => {
    const { app } = buildApp({ recordFails: true });

    const reply = await get(app, "/pass-claims/the-token");

    expect(reply.status).toBe(200);
    expect(reply.bytes.toString()).toBe("signed");
  });
});
