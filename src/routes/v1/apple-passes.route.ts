import { Router, type RequestHandler } from "express";

import { asyncHandler } from "../../common/middleware/async-handler";
import { LoyaltyCardAssembler } from "../../wallet/engine/loyalty-card-assembler";
import { PassDeviceRepository } from "../../wallet/engine/pass-device.repository";
import { AppleWalletProvider } from "../../wallet/providers/apple/apple-wallet.provider";

/**
 * Apple's PassKit web service.
 *
 * These four endpoints are what turn a pass from a snapshot into a living card. Apple
 * appends `/v1/...` to the `webServiceURL` baked into each pass, and this app already
 * mounts its API at `/api/v1` — so the pass carries `https://host/api` and the paths
 * below line up without a second router.
 *
 * The status codes carry meaning and are the easiest thing here to get subtly wrong:
 * 200 versus 204 on the updated-serials call decides whether devices fetch or go quiet,
 * and a 401 that should have been a 404 teaches a device to stop asking. Each one is
 * spelled out at its handler rather than left to a reader's memory of the spec.
 *
 * Deliberately NOT behind the staff key or the edge guard: the callers are members'
 * iPhones on the open internet. Their credential is the per-pass bearer token, which is
 * the only thing that authorises anything here.
 */
export interface ApplePassesRouterDeps {
  provider: AppleWalletProvider;
  devices: PassDeviceRepository;
  assembler: LoyaltyCardAssembler;
  /** Injected so tests can freeze it; the real one is `() => new Date()`. */
  now?: () => Date;
}

const AUTH_SCHEME = /^ApplePass\s+(.+)$/i;

export const createApplePassesRouter = (deps: ApplePassesRouterDeps): Router => {
  const router = Router();
  const now = deps.now ?? (() => new Date());

  /**
   * Apple sends `Authorization: ApplePass <token>`. A missing or malformed header is the
   * same 401 as a wrong token: telling the two apart tells a prober which serials exist.
   */
  const authorise: RequestHandler = (req, res, next) => {
    const match = AUTH_SCHEME.exec(req.get("authorization") ?? "");
    const serialNumber = req.params.serialNumber;

    if (!match || !serialNumber) {
      res.sendStatus(401);

      return;
    }

    deps.provider
      .authenticate(serialNumber, match[1].trim())
      .then((ok) => {
        if (!ok) {
          res.sendStatus(401);

          return;
        }

        next();
      })
      .catch(next);
  };

  /**
   * Register a device for a pass.
   *
   * 201 when this is new, 200 when the device already had it — Apple uses the difference
   * to decide whether to retry, so collapsing them into one makes a rotated push token
   * look like a fresh registration.
   */
  router.post(
    "/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
    authorise,
    asyncHandler(async (req, res) => {
      const pushToken = (req.body as { pushToken?: unknown } | undefined)?.pushToken;

      if (typeof pushToken !== "string" || pushToken.length === 0) {
        res.sendStatus(400);

        return;
      }

      const { created } = await deps.devices.saveRegistration({
        deviceLibraryIdentifier: req.params.deviceLibraryIdentifier,
        passTypeIdentifier: req.params.passTypeIdentifier,
        serialNumber: req.params.serialNumber,
        pushToken
      });

      res.sendStatus(created ? 201 : 200);
    })
  );

  /**
   * The member deleted the pass.
   *
   * 200 whether or not a row was there: the device's intent is "stop telling me", and a
   * 404 would make it retry something already true.
   */
  router.delete(
    "/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier/:serialNumber",
    authorise,
    asyncHandler(async (req, res) => {
      await deps.devices.removeRegistration(
        req.params.deviceLibraryIdentifier,
        req.params.passTypeIdentifier,
        req.params.serialNumber
      );

      res.sendStatus(200);
    })
  );

  /**
   * Which of this device's passes changed.
   *
   * No pass-token auth, by Apple's design: the call is scoped to a device rather than to
   * one pass, so there is no single token to present. The device library identifier is
   * the only secret involved.
   *
   * 204 for "nothing changed" and 200 with a list otherwise. Getting that backwards is
   * the classic bug: a 200 with an empty array makes devices keep polling, and a 204 when
   * something did change makes them never fetch.
   */
  router.get(
    "/devices/:deviceLibraryIdentifier/registrations/:passTypeIdentifier",
    asyncHandler(async (req, res) => {
      const raw = req.query.passesUpdatedSince;
      const since = typeof raw === "string" && raw ? new Date(Number(raw) * 1000) : undefined;

      const { serialNumbers, lastUpdated } = await deps.devices.serialsUpdatedSince(
        req.params.deviceLibraryIdentifier,
        req.params.passTypeIdentifier,
        since && !Number.isNaN(since.getTime()) ? since : undefined
      );

      if (serialNumbers.length === 0) {
        res.sendStatus(204);

        return;
      }

      res.json({
        serialNumbers,
        // Echoed back on the device's next call. Seconds, as a string, because that is
        // what the device round-trips verbatim.
        lastUpdated: String(Math.floor((lastUpdated ?? now()).getTime() / 1000))
      });
    })
  );

  /**
   * The latest version of a pass.
   *
   * Rebuilt from the card on every request rather than served from storage: the ledger is
   * the source of truth and a cached file would be one sync behind. `Last-Modified` plus
   * a 304 on `If-Modified-Since` is what stops a device downloading a pass it already has.
   */
  router.get(
    "/passes/:passTypeIdentifier/:serialNumber",
    authorise,
    asyncHandler(async (req, res) => {
      // Scoped by the pass type in the URL, so a device holding a retired pass type gets a
      // 404 for it rather than the current pass under a serial it happens to share.
      const record = await deps.devices.passRecordFor(
        req.params.passTypeIdentifier,
        req.params.serialNumber
      );

      // Authorised by a valid token but unknown to us: the pass was issued and the
      // WalletObject row has since gone, e.g. after a revoke. 404, not 401 — the token
      // was right, the pass is simply no longer ours to serve.
      if (!record) {
        res.sendStatus(404);

        return;
      }

      // The pass's own modification time, not the clock. HTTP dates have one-second
      // resolution, so it is floored before comparing — otherwise a pass modified at
      // .400s never matches the .000s the device echoes back and every poll re-downloads.
      const lastModified = new Date(
        Math.floor((record.lastUpdated ?? now()).getTime() / 1000) * 1000
      );

      const ifModifiedSince = req.get("if-modified-since");

      if (ifModifiedSince) {
        const seen = new Date(ifModifiedSince);

        if (!Number.isNaN(seen.getTime()) && seen >= lastModified) {
          res.sendStatus(304);

          return;
        }
      }

      const card = await deps.assembler.assemble(record.memberId);
      const built = await deps.provider.buildPassFor(card);

      res
        .status(200)
        .type("application/vnd.apple.pkpass")
        .set("Last-Modified", lastModified.toUTCString())
        .send(built.buffer);
    })
  );

  /**
   * Device diagnostics.
   *
   * Apple posts here when it cannot use a pass, and the messages are often the only
   * evidence of why a real device rejected something that validated server-side. Always
   * 200: a device that cannot log must not conclude the service is broken.
   */
  router.post("/log", (req, res) => {
    const logs = (req.body as { logs?: unknown } | undefined)?.logs;

    if (Array.isArray(logs)) {
      for (const entry of logs) {
        console.warn("[apple-wallet] device log:", String(entry).slice(0, 500));
      }
    }

    res.sendStatus(200);
  });

  return router;
};
