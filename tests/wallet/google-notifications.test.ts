import { beforeEach, describe, expect, it, vi } from "vitest";

const request = vi.fn();

vi.mock("../../src/wallet/providers/google/client", () => ({
  assertIssuerScopedId: vi.fn(),
  getAuthenticatedClient: () => ({ request }),
  GoogleWalletApiError: class GoogleWalletApiError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly statusText: string,
      readonly responseBody?: unknown
    ) {
      super(message);
    }
  }
}));

describe("Google Wallet notifications", () => {
  beforeEach(() => {
    request.mockReset();
  });

  it("adds an object message with TEXT_AND_NOTIFY only when notify is requested", async () => {
    const { addObjectMessage } = await import("../../src/wallet/providers/google/objectService");

    request.mockResolvedValueOnce({});

    await addObjectMessage("issuer.member_1", {
      header: "Offer",
      body: "Come in today",
      notify: true
    });

    expect(request).toHaveBeenCalledWith("/loyaltyObject/issuer.member_1/addMessage", {
      method: "POST",
      body: {
        message: expect.objectContaining({
          header: "Offer",
          body: "Come in today",
          messageType: "TEXT_AND_NOTIFY"
        })
      }
    });
  });

  it("adds a class message with TEXT_AND_NOTIFY for broadcast sends", async () => {
    const { addClassMessage } = await import("../../src/wallet/providers/google/classService");

    request.mockResolvedValueOnce({});

    await addClassMessage("issuer.class_1", {
      header: "Broadcast",
      body: "Class-wide update",
      notify: true
    });

    expect(request).toHaveBeenCalledWith("/loyaltyClass/issuer.class_1/addMessage", {
      method: "POST",
      body: {
        message: expect.objectContaining({
          header: "Broadcast",
          body: "Class-wide update",
          messageType: "TEXT_AND_NOTIFY"
        })
      }
    });
  });

  it("sets notifyPreference on points patches only when a field-update push is wanted", async () => {
    const { patchObject } = await import("../../src/wallet/providers/google/objectService");

    request.mockResolvedValueOnce({ textModulesData: [], loyaltyPoints: { label: "Points" } });
    request.mockResolvedValueOnce({});

    await patchObject("issuer.member_1", { loyaltyPointsBalance: 400, notify: true });

    expect(request).toHaveBeenLastCalledWith("/loyaltyObject/issuer.member_1", {
      method: "PATCH",
      body: expect.objectContaining({ notifyPreference: "notifyOnUpdate" })
    });
  });
});