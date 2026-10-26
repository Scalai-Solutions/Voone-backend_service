import type { AddressInfo } from "node:net";

import express from "express";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageStorageError } from "../../src/common/errors/image.errors";
import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import { errorHandler } from "../../src/common/middleware/error-handler";
import type { ImageStorage } from "../../src/modules/media/image-storage";
import { MAX_IMAGE_BYTES } from "../../src/modules/media/image-upload.service";
import { makeImage, makeRandomPng, makeSvg } from "./image-fixtures";

import { createImagesRouter } from "../../src/routes/v1/images.route";

const STAFF_KEY = "test-staff-key";

const GENERIC_MESSAGE = "Sube una imagen PNG, JPG o WebP.";

const build = (
  options: { configured?: boolean; failStorage?: Error; staffKey?: string | undefined } = {}
) => {
  const puts: Array<{ key: string; contentType: string; size: number }> = [];
  const lookups: string[] = [];

  const storage: ImageStorage = {
    put: async (key, bytes, contentType) => {
      if (options.failStorage) throw options.failStorage;

      puts.push({ key, contentType, size: bytes.length });

      return { url: `https://cdn.test/${key}` };
    }
  };

  const app = express();

  // The same global parser the real app has, so the raw routes are tested behind it.
  app.use(express.json());
  app.use(
    "/api/v1",
    createImagesRouter({
      staffKey: "staffKey" in options ? options.staffKey : STAFF_KEY,
      storage: options.configured === false ? null : storage,
      findClinic: async (slug) => {
        lookups.push(slug);
        if (slug !== "aurea") throw new ClinicNotFoundError(slug);

        return { id: "clinic-aurea" };
      }
    })
  );
  app.use(errorHandler);

  return { app, puts, lookups };
};

const send = async (
  app: express.Express,
  path: string,
  options: {
    body?: Buffer | string;
    type?: string;
    staff?: boolean | string;
    headers?: Record<string, string>;
    /** Send the body as a stream, so there is no Content-Length (chunked). */
    chunked?: Buffer;
  } = {}
) => {
  const server = app.listen(0);

  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = {};

    if (options.type) headers["content-type"] = options.type;
    if (options.staff !== false) {
      headers["x-voone-staff-key"] = typeof options.staff === "string" ? options.staff : STAFF_KEY;
    }

    Object.assign(headers, options.headers);

    const chunked = options.chunked;
    const body = chunked
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            const step = 64 * 1024;

            for (let at = 0; at < chunked.length; at += step) {
              controller.enqueue(new Uint8Array(chunked.subarray(at, at + step)));
            }

            controller.close();
          }
        })
      : typeof options.body === "object"
        ? new Uint8Array(options.body)
        : options.body;

    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method: "POST",
      headers,
      body,
      ...(chunked ? { duplex: "half" } : {})
    } as RequestInit);
    const text = await response.text();

    return {
      status: response.status,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : null
    };
  } finally {
    server.close();
  }
};

afterEach(() => vi.restoreAllMocks());

describe("POST /clinics/:slug/images", () => {
  it("stores a valid image under the clinic the slug names and answers 201 with its URL", async () => {
    const { app, puts } = build();
    const png = await makeImage("png", 40, 20);

    const res = await send(app, "/clinics/aurea/images?kind=logo", {
      body: png,
      type: "image/png"
    });

    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      url: expect.stringMatching(
        /^https:\/\/cdn\.test\/clinics\/clinic-aurea\/logo-[0-9a-f]{16}\.png$/
      ),
      bytes: png.length,
      width: 40,
      height: 20,
      contentType: "image/png"
    });
    expect(puts).toHaveLength(1);
  });

  it("takes the folder from the slug, never from anything else in the request", async () => {
    const { app, puts } = build();

    const res = await send(app, "/clinics/aurea/images?kind=hero&clinicId=other&key=../x", {
      body: await makeImage("jpeg"),
      type: "image/jpeg"
    });

    expect(res.status).toBe(201);
    expect(puts[0]?.key).toMatch(/^clinics\/clinic-aurea\/hero-[0-9a-f]{16}\.jpg$/);
  });

  it("uses the detected format for the key and content type, not the declared one", async () => {
    const { app, puts } = build();

    const res = await send(app, "/clinics/aurea/images?kind=logoOnDark", {
      body: await makeImage("webp"),
      type: "image/png"
    });

    expect(res.status).toBe(201);
    expect(res.body?.contentType).toBe("image/webp");
    expect(puts[0]).toMatchObject({ contentType: "image/webp" });
    expect(puts[0]?.key).toMatch(/\.webp$/);
  });

  it("answers 404 for an unknown clinic and stores nothing", async () => {
    const { app, puts } = build();

    const res = await send(app, "/clinics/nope/images?kind=logo", {
      body: await makeImage("png"),
      type: "image/png"
    });

    expect(res.status).toBe(404);
    expect(puts).toEqual([]);
  });

  it("requires the staff key", async () => {
    const { app, puts, lookups } = build();
    const body = await makeImage("png");

    const none = await send(app, "/clinics/aurea/images?kind=logo", {
      body,
      type: "image/png",
      staff: false
    });
    const wrong = await send(app, "/clinics/aurea/images?kind=logo", {
      body,
      type: "image/png",
      staff: "not-the-key"
    });

    expect(none.status).toBe(403);
    expect(wrong.status).toBe(403);
    expect(puts).toEqual([]);
    expect(lookups).toEqual([]);
  });
});

describe("POST /admin/images", () => {
  it("stores under shared/ and answers 201", async () => {
    const { app, puts, lookups } = build();

    const res = await send(app, "/admin/images?kind=logo", {
      body: await makeImage("png"),
      type: "image/png"
    });

    expect(res.status).toBe(201);
    expect(puts[0]?.key).toMatch(/^shared\/logo-[0-9a-f]{16}\.png$/);
    expect(lookups).toEqual([]);
  });

  it("requires the staff key", async () => {
    const { app, puts } = build();

    const res = await send(app, "/admin/images?kind=logo", {
      body: await makeImage("png"),
      type: "image/png",
      staff: false
    });

    expect(res.status).toBe(403);
    expect(puts).toEqual([]);
  });
});

describe.each([
  ["clinic", "/clinics/aurea/images"],
  ["admin", "/admin/images"]
])("errors on the %s route", (_name, base) => {
  it("answers 503 with the Spanish message when storage is not configured", async () => {
    const { app } = build({ configured: false });

    const res = await send(app, `${base}?kind=logo`, {
      body: await makeImage("png"),
      type: "image/png"
    });

    expect(res.status).toBe(503);
    expect(res.body?.message).toBe("La subida de imágenes no está configurada.");
  });

  it("answers 415 for a content type that is not PNG, JPEG or WebP", async () => {
    const { app, puts } = build();

    for (const type of ["image/svg+xml", "image/gif", "application/json", "text/plain"]) {
      const res = await send(app, `${base}?kind=logo`, {
        body: type === "application/json" ? "{}" : makeSvg(),
        type
      });

      expect(res.status, type).toBe(415);
      expect(res.body?.message).toBe(GENERIC_MESSAGE);
    }

    const noBody = await send(app, `${base}?kind=logo`, {});

    expect(noBody.status).toBe(415);
    expect(puts).toEqual([]);
  });

  it("answers 413 for a body over 5 MB", async () => {
    const { app, puts } = build();

    const res = await send(app, `${base}?kind=logo`, {
      body: Buffer.alloc(MAX_IMAGE_BYTES + 1),
      type: "image/png"
    });

    expect(res.status).toBe(413);
    expect(res.body?.message).toBe("La imagen supera los 5 MB.");
    expect(puts).toEqual([]);
  });

  it("answers 422 for bytes that are not an image, even labelled image/png", async () => {
    const { app, puts } = build();

    const res = await send(app, `${base}?kind=logo`, { body: makeSvg(), type: "image/png" });

    expect(res.status).toBe(422);
    expect(res.body?.message).toBe(GENERIC_MESSAGE);
    expect(puts).toEqual([]);
  });

  it("answers 422 for an image of the wrong size", async () => {
    const { app } = build();

    const res = await send(app, `${base}?kind=logo`, {
      body: await makeImage("png", 2, 2),
      type: "image/png"
    });

    expect(res.status).toBe(422);
    expect(res.body?.message).toBe("El tamaño de la imagen no es válido.");
  });

  it.each(["", "?kind=banner", "?kind=LOGO"])("answers 422 for kind %j", async (query) => {
    const { app, puts } = build();

    const res = await send(app, `${base}${query}`, {
      body: await makeImage("png"),
      type: "image/png"
    });

    expect(res.status).toBe(422);
    expect(res.body?.message).toBe("Tipo de imagen no válido.");
    expect(puts).toEqual([]);
  });

  it("answers 502 with only the fixed code and message when storage fails", async () => {
    const { app } = build({ failStorage: new ImageStorageError(new Error("boom secret")) });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await send(app, `${base}?kind=logo`, {
      body: await makeImage("png"),
      type: "image/png"
    });

    // toEqual on the whole body: a cause, a stack or provider detail added to the response
    // would fail it.
    expect(res.status).toBe(502);
    expect(res.body).toEqual({
      code: "IMAGE_STORAGE_FAILED",
      message: "No se ha podido guardar la imagen. Inténtalo de nuevo."
    });
    // The storage adapter logged the failure; the generic handler does not repeat it.
    expect(log).not.toHaveBeenCalled();
  });

  it("does not log the unconfigured case as an error", async () => {
    const { app } = build({ configured: false });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await send(app, `${base}?kind=logo`, { body: await makeImage("png"), type: "image/png" });

    expect(log).not.toHaveBeenCalled();
  });

  it("answers 503, not 403 or 201, when no staff key is configured (fails closed)", async () => {
    const { app, puts, lookups } = build({ staffKey: undefined });

    for (const staff of [false, true, "anything"] as const) {
      const res = await send(app, `${base}?kind=logo`, {
        body: await makeImage("png"),
        type: "image/png",
        staff
      });

      expect(res.status).toBe(503);
      expect(res.body?.message).toBe("La subida de imágenes no está configurada.");
    }

    expect(puts).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it("checks the staff configuration before reading any body", async () => {
    const { app } = build({ staffKey: undefined });

    // Over the limit: if the body were read first this would be 413.
    const res = await send(app, `${base}?kind=logo`, {
      body: Buffer.alloc(MAX_IMAGE_BYTES + 1),
      type: "image/png"
    });

    expect(res.status).toBe(503);
  });

  it("answers 413 for an over-limit body sent chunked, with no Content-Length", async () => {
    const { app, puts } = build();

    const res = await send(app, `${base}?kind=logo`, {
      chunked: Buffer.alloc(MAX_IMAGE_BYTES + 1),
      type: "image/png"
    });

    expect(res.status).toBe(413);
    expect(res.body?.message).toBe("La imagen supera los 5 MB.");
    expect(puts).toEqual([]);
  });

  it("answers 415 for a Content-Encoding it cannot decode", async () => {
    const { app, puts } = build();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await send(app, `${base}?kind=logo`, {
      body: await makeImage("png"),
      type: "image/png",
      headers: { "content-encoding": "br" }
    });

    expect(res.status).toBe(415);
    expect(res.body?.message).toBe(GENERIC_MESSAGE);
    expect(puts).toEqual([]);
  });

  it("answers 400 with the Spanish message for a corrupt gzip body, not 500", async () => {
    const { app, puts } = build();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await send(app, `${base}?kind=logo`, {
      body: Buffer.from("this is not gzip data at all"),
      type: "image/png",
      headers: { "content-encoding": "gzip" }
    });

    expect(res.status).toBe(400);
    expect(res.body?.message).toBe("La imagen no se ha podido leer. Inténtalo de nuevo.");
    expect(puts).toEqual([]);
  });

  it("accepts a gzip-encoded image body", async () => {
    const { app, puts } = build();

    const res = await send(app, `${base}?kind=logo`, {
      body: gzipSync(await makeImage("png")),
      type: "image/png",
      headers: { "content-encoding": "gzip" }
    });

    expect(res.status).toBe(201);
    expect(puts).toHaveLength(1);
  });

  it("accepts a real image of about 4 MB, well over the default parser limit", async () => {
    const { app, puts } = build();
    const big = await makeRandomPng(1150);

    expect(big.length).toBeGreaterThan(3_500_000);
    expect(big.length).toBeLessThan(MAX_IMAGE_BYTES);

    const res = await send(app, `${base}?kind=hero`, { body: big, type: "image/png" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ bytes: big.length, width: 1150, height: 1150 });
    expect(puts[0]?.size).toBe(big.length);
  });
});
