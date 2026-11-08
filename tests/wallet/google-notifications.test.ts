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

  describe("keeps only the latest 2 messages on a pass", () => {
    const messages = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}`, header: "H", body: "B" }));

    it("drops the oldest object message once a third arrives", async () => {
      const { addObjectMessage } = await import("../../src/wallet/providers/google/objectService");
      request.mockResolvedValueOnce({ resource: { messages: messages(3) } });
      request.mockResolvedValueOnce({});

      await addObjectMessage("issuer.member_1", { header: "H", body: "B", notify: false });

      expect(request).toHaveBeenLastCalledWith("/loyaltyObject/issuer.member_1", {
        method: "PATCH",
        body: { messages: messages(3).slice(1) }
      });
    });

    it("drops the oldest class message once a third arrives", async () => {
      const { addClassMessage } = await import("../../src/wallet/providers/google/classService");
      request.mockResolvedValueOnce({ resource: { messages: messages(3) } });
      request.mockResolvedValueOnce({});

      await addClassMessage("issuer.class_1", { header: "H", body: "B", notify: false });

      expect(request).toHaveBeenLastCalledWith("/loyaltyClass/issuer.class_1", {
        method: "PATCH",
        body: { messages: messages(3).slice(1) }
      });
    });

    it("does not patch while 2 or fewer are on the pass", async () => {
      const { addObjectMessage } = await import("../../src/wallet/providers/google/objectService");
      request.mockResolvedValueOnce({ resource: { messages: messages(2) } });

      await addObjectMessage("issuer.member_1", { header: "H", body: "B", notify: false });

      expect(request).toHaveBeenCalledTimes(1);
    });

    it("still returns the message id when the trim fails", async () => {
      const { addObjectMessage } = await import("../../src/wallet/providers/google/objectService");
      request.mockResolvedValueOnce({ resource: { messages: messages(6) } });
      request.mockRejectedValueOnce(new Error("boom"));
      vi.spyOn(console, "error").mockImplementation(() => {});

      await expect(
        addObjectMessage("issuer.member_1", { id: "new", header: "H", body: "B", notify: false })
      ).resolves.toBe("new");
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
