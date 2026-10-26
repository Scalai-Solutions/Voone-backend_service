import type { AddressInfo } from "node:net";

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageStorageError } from "../../src/common/errors/image.errors";
import { ClinicNotFoundError } from "../../src/common/errors/membership.errors";
import { errorHandler } from "../../src/common/middleware/error-handler";
import type { ImageStorage } from "../../src/modules/media/image-storage";
import { MAX_IMAGE_BYTES } from "../../src/modules/media/image-upload.service";
import { makeImage, makeSvg } from "./image-fixtures";

const STAFF_KEY = vi.hoisted(() => "test-staff-key");

// The staff gate is a no-op when no key is configured, so configure one.
vi.mock("../../src/config/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../src/config/env")>();

  return { ...original, config: { ...original.config, STAFF_API_KEY: STAFF_KEY } };
});

const { createImagesRouter } = await import("../../src/routes/v1/images.route");

const GENERIC_MESSAGE = "Sube una imagen PNG, JPG o WebP.";

const build = (options: { configured?: boolean; failStorage?: Error } = {}) => {
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
  options: { body?: Buffer | string; type?: string; staff?: boolean | string } = {}
) => {
  const server = app.listen(0);

  try {
    const { port } = server.address() as AddressInfo;
    const headers: Record<string, string> = {};

    if (options.type) headers["content-type"] = options.type;
    if (options.staff !== false) {
      headers["x-voone-staff-key"] = typeof options.staff === "string" ? options.staff : STAFF_KEY;
    }

    const response = await fetch(`http://127.0.0.1:${port}/api/v1${path}`, {
      method: "POST",
      headers,
      body: typeof options.body === "object" ? new Uint8Array(options.body) : options.body
    });
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

  it("answers 502 when storage fails, without the underlying error", async () => {
    const { app } = build({ failStorage: new ImageStorageError(new Error("boom secret")) });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const res = await send(app, `${base}?kind=logo`, {
      body: await makeImage("png"),
      type: "image/png"
    });

    expect(res.status).toBe(502);
    expect(res.body?.message).toBe("No se ha podido guardar la imagen. Inténtalo de nuevo.");
    expect(JSON.stringify(res.body)).not.toContain("boom");
  });
});
