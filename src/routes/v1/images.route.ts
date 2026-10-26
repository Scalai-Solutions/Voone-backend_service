import express, { Router, type RequestHandler } from "express";

import {
  ImageStorageUnavailableError,
  ImageTooLargeError,
  ImageUnreadableError,
  ImageUnsupportedMediaTypeError
} from "../../common/errors/image.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createRequireStaffKey } from "../../common/middleware/staff-key";
import type { ImageStorage } from "../../modules/media/image-storage";
import {
  MAX_IMAGE_BYTES,
  parseImageKind,
  uploadImage
} from "../../modules/media/image-upload.service";

export interface ImagesRouterDeps {
  /**
   * The staff key. Unlike the other staff routes these FAIL CLOSED: with no key configured
   * the routes answer 503 instead of letting anyone upload to the storage account.
   */
  staffKey: string | undefined;
  /** Null when storage is not configured: the routes then answer 503. */
  storage: ImageStorage | null;
  /** Resolves a clinic slug to its id, or throws the 404 the rest of the API uses. */
  findClinic: (slug: string) => Promise<{ id: string }>;
}

const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/webp"];

/**
 * What body-parser's own errors mean here. Each carries a `type` and an HTTP `status`;
 * left alone they would all reach the generic handler as a 500.
 */
const bodyParserFailure = (error: unknown): unknown => {
  const { type, status } = error as { type?: unknown; status?: unknown };

  if (type === "entity.too.large") return new ImageTooLargeError();
  if (type === "encoding.unsupported") return new ImageUnsupportedMediaTypeError();

  // Corrupt gzip, a Content-Length that does not match, an aborted request: the client's
  // problem, and worth retrying. Anything without a client status stays a 500.
  if (typeof status === "number" && status >= 400 && status < 500) {
    return new ImageUnreadableError(error);
  }

  return error;
};

/**
 * The raw image bytes as a Buffer, and clean errors for what body-parser would otherwise
 * leave to the generic handler. Only these routes use it: the app's global `express.json()`
 * ignores image content types, so the body reaches here untouched.
 */
const rawImageBody = (): RequestHandler => {
  const parse = express.raw({ type: ACCEPTED_TYPES, limit: MAX_IMAGE_BYTES });

  return (req, res, next) => {
    parse(req, res, (error?: unknown) => {
      if (error) {
        next(bodyParserFailure(error));

        return;
      }

      // Anything else leaves req.body as `{}` (or a parsed object): not an image type.
      if (!Buffer.isBuffer(req.body)) {
        next(new ImageUnsupportedMediaTypeError());

        return;
      }

      next();
    });
  };
};

/**
 * Image uploads for wallet cards: a logo, a dark-background logo or a hero image.
 *
 * The body is the raw image, not multipart, and the response is the PUBLIC https URL the
 * dashboard then writes into the template's logoUrl / logoOnDarkUrl / heroImageUrl.
 *
 * Behind the staff key like the other staff routes, ahead of the body parser so an
 * unauthenticated caller cannot make the server buffer 5 MB. A clinic upload takes its
 * folder from the slug's clinic, never from the request; the admin route writes to a shared
 * folder because the clinic may not exist yet in the onboarding wizard.
 */
export const createImagesRouter = (deps: ImagesRouterDeps): Router => {
  const router = Router();
  const requireStaff = createRequireStaffKey(deps.staffKey);

  // First of all, before the key is even compared and before any body is read.
  const requireStaffConfigured: RequestHandler = (_req, _res, next) => {
    next(deps.staffKey ? undefined : new ImageStorageUnavailableError());
  };

  const upload = (scope: (slug: string) => Promise<{ clinicId: string } | "shared">) =>
    [
      requireStaffConfigured,
      requireStaff,
      // Cheap refusals first, before a body is read.
      asyncHandler(async (req, res, next) => {
        if (!deps.storage) throw new ImageStorageUnavailableError();

        res.locals.kind = parseImageKind(req.query.kind);
        res.locals.scope = await scope(req.params.slug ?? "");
        next();
      }),
      rawImageBody(),
      asyncHandler(async (req, res) => {
        const result = await uploadImage(
          { scope: res.locals.scope, kind: res.locals.kind, bytes: req.body as Buffer },
          deps.storage as ImageStorage
        );

        res.status(201).json(result);
      })
    ] satisfies RequestHandler[];

  router.post(
    "/clinics/:slug/images",
    ...upload(async (slug) => ({ clinicId: (await deps.findClinic(slug)).id }))
  );

  router.post("/admin/images", ...upload(async () => "shared" as const));

  return router;
};
