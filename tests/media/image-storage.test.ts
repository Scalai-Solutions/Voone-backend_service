import { afterEach, describe, expect, it, vi } from "vitest";

import { ImageStorageError } from "../../src/common/errors/image.errors";
import { BunnyImageStorage, buildImageStorage } from "../../src/modules/media/image-storage";

const KEY = "unit-test-write-password-not-real";

const storage = () =>
  new BunnyImageStorage({
    endpoint: "https://storage.example.test",
    zone: "my-zone",
    accessKey: KEY,
    publicBaseUrl: "https://cdn.example.test"
  });

const mockFetch = (response: Response | Error) =>
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    if (response instanceof Error) throw response;

    return response;
  });

afterEach(() => vi.restoreAllMocks());

describe("BunnyImageStorage.put", () => {
  it("PUTs the bytes to {endpoint}/{zone}/{key} with the AccessKey and content type", async () => {
    const spy = mockFetch(new Response('{"HttpCode":201}', { status: 201 }));
    const bytes = Buffer.from([1, 2, 3, 4]);

    await storage().put("clinics/c1/logo-abc.png", bytes, "image/png");

    expect(spy).toHaveBeenCalledTimes(1);

    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);

    expect(url).toBe("https://storage.example.test/my-zone/clinics/c1/logo-abc.png");
    expect(init.method).toBe("PUT");
    expect(headers.get("AccessKey")).toBe(KEY);
    expect(headers.get("Content-Type")).toBe("image/png");
    expect(Buffer.from(init.body as Uint8Array)).toEqual(bytes);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns the public pull-zone URL, not the storage URL", async () => {
    mockFetch(new Response("", { status: 201 }));

    await expect(
      storage().put("shared/hero-1.webp", Buffer.from("x"), "image/webp")
    ).resolves.toEqual({ url: "https://cdn.example.test/shared/hero-1.webp" });
  });

  it("maps a non-success status to the 502 error and logs it without the key or into the response", async () => {
    mockFetch(new Response(`denied for AccessKey ${KEY}`, { status: 401 }));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failure = await storage()
      .put("shared/logo-1.png", Buffer.from("x"), "image/png")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ImageStorageError);
    expect((failure as ImageStorageError).statusCode).toBe(502);
    expect((failure as ImageStorageError).message).toBe(
      "No se ha podido guardar la imagen. Inténtalo de nuevo."
    );
    expect(JSON.stringify(failure)).not.toContain(KEY);
    expect(String((failure as Error).message)).not.toContain("denied");

    // The operator sees the status and body; the key itself is never logged.
    const logged = JSON.stringify(log.mock.calls);

    expect(logged).toContain("401");
    expect(logged).toContain("denied");
    expect(logged).toContain("[redacted]");
    expect(logged).not.toContain(KEY);
  });

  it("maps a network error to the 502 error", async () => {
    mockFetch(new TypeError("fetch failed"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      storage().put("shared/logo-1.png", Buffer.from("x"), "image/png")
    ).rejects.toMatchObject({ statusCode: 502, code: "IMAGE_STORAGE_FAILED" });
  });

  it("maps a timeout to the 502 error", async () => {
    mockFetch(new DOMException("The operation timed out.", "TimeoutError"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      storage().put("shared/logo-1.png", Buffer.from("x"), "image/png")
    ).rejects.toBeInstanceOf(ImageStorageError);
  });

  it("does not put the key in the error's cause either", async () => {
    mockFetch(new Response("nope", { status: 500 }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const failure = (await storage()
      .put("shared/logo-1.png", Buffer.from("x"), "image/png")
      .catch((error: unknown) => error)) as { cause?: unknown };

    expect(JSON.stringify(failure.cause ?? null)).not.toContain(KEY);
    expect(String(failure.cause ?? "")).not.toContain(KEY);
  });
});

describe("buildImageStorage", () => {
  const full = {
    BUNNY_STORAGE_ZONE: "z",
    BUNNY_STORAGE_ENDPOINT: "https://storage.bunnycdn.com",
    BUNNY_STORAGE_ACCESS_KEY: KEY,
    BUNNY_PUBLIC_BASE_URL: "https://cdn.example.test"
  };

  it("builds a storage when zone, key and public base URL are set", () => {
    expect(buildImageStorage(full)).toBeInstanceOf(BunnyImageStorage);
  });

  it.each(["BUNNY_STORAGE_ZONE", "BUNNY_STORAGE_ACCESS_KEY", "BUNNY_PUBLIC_BASE_URL"] as const)(
    "is null when %s is missing",
    (name) => {
      expect(buildImageStorage({ ...full, [name]: undefined })).toBeNull();
    }
  );
});
