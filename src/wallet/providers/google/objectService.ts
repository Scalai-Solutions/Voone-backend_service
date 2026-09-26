import { assertIssuerScopedId, getAuthenticatedClient, GoogleWalletApiError } from "./client";
import type { LoyaltyObjectInput, LoyaltyObjectPatch, LoyaltyObjectState } from "./types";

interface GoogleLoyaltyPointsBalance {
  string?: string;
  int?: number;
  double?: number;
}

interface GoogleLoyaltyPoints {
  label?: string;
  balance?: GoogleLoyaltyPointsBalance;
}

interface GoogleMessage {
  header: string;
  body: string;
}

interface GoogleBarcode {
  type: "QR_CODE";
  value: string;
  alternateText: string;
}

interface GoogleLoyaltyObject {
  id: string;
  classId: string;
  accountName?: string;
  accountId?: string;
  loyaltyPoints?: GoogleLoyaltyPoints;
  state?: LoyaltyObjectState;
  textModulesData?: Array<{
    id: string;
    header: string;
    body: string;
  }>;
  messages?: GoogleMessage[];
  rewardsTier?: string;
  classReference?: {
    rewardsTier?: string;
  };
}

interface GoogleLoyaltyObjectRequest {
  id: string;
  classId: string;
  accountName: string;
  accountId: string;
  loyaltyPoints: {
    label: string;
    balance: {
      string: string;
    };
  };
  state: LoyaltyObjectState;
  barcode: GoogleBarcode;
  textModulesData: Array<{
    id: string;
    header: string;
    body: string;
  }>;
  rewardsTier?: string;
}

interface GoogleLoyaltyObjectPatchRequest {
  accountName?: string;
  accountId?: string;
  loyaltyPoints?: {
    label?: string;
    balance: {
      string: string;
    };
  };
  state?: LoyaltyObjectState;
  barcode?: GoogleBarcode;
  textModulesData?: Array<{
    id: string;
    header: string;
    body: string;
  }>;
  rewardsTier?: string;
  messages?: GoogleMessage[];
}

export const createObject = async (input: LoyaltyObjectInput): Promise<void> => {
  assertIssuerScopedId(input.objectId, "objectId");
  assertIssuerScopedId(input.classId, "classId");

  const client = getAuthenticatedClient();

  try {
    await client.request<unknown>("/loyaltyObject", {
      method: "POST",
      body: toGoogleLoyaltyObjectBody(input)
    });
  } catch (error) {
    if (error instanceof GoogleWalletApiError && error.status === 409) {
      console.warn("Google Wallet LoyaltyObject already exists; patching test object", {
        objectId: input.objectId
      });

      await client.request<unknown>(`/loyaltyObject/${encodeURIComponent(input.objectId)}`, {
        method: "PATCH",
        body: toGoogleLoyaltyObjectPatchBody(input)
      });
      return;
    }

    throw error;
  }
};

export const patchObject = async (objectId: string, patch: LoyaltyObjectPatch): Promise<void> => {
  assertIssuerScopedId(objectId, "objectId");

  const client = getAuthenticatedClient();
  const body: GoogleLoyaltyObjectPatchRequest = {};

  if (patch.loyaltyPointsBalance !== undefined || patch.tier !== undefined) {
    const existingObject = await client.request<GoogleLoyaltyObject>(
      `/loyaltyObject/${encodeURIComponent(objectId)}`
    );
    const existingTextModules = existingObject.textModulesData ?? [];

    body.textModulesData = upsertTextModules(existingTextModules, [
      ...(patch.loyaltyPointsBalance !== undefined
        ? [
            {
              id: "points",
              header: existingObject.loyaltyPoints?.label ?? "Points",
              body: String(patch.loyaltyPointsBalance)
            }
          ]
        : []),
      ...(patch.tier !== undefined ? [{ id: "tier", header: "Tier", body: patch.tier }] : [])
    ]);
  }

  if (patch.loyaltyPointsBalance !== undefined) {
    body.loyaltyPoints = {
      balance: {
        string: String(patch.loyaltyPointsBalance)
      }
    };
  }

  if (patch.state !== undefined) {
    body.state = patch.state;
  }

  if (patch.tier !== undefined) {
    // TODO: Verify object-level tier support against https://developers.google.com/wallet/retail/loyalty-cards/rest/v1/loyaltyclass before relying on this field in production.
    // As of now, this field has no effect when written on a LoyaltyObject; only LoyaltyClass.rewardsTier is real.
    body.rewardsTier = patch.tier;
  }

  if (patch.message) {
    const existingObject = await client.request<GoogleLoyaltyObject>(
      `/loyaltyObject/${encodeURIComponent(objectId)}`
    );
    body.messages = [...(existingObject.messages ?? []), patch.message].slice(-10);
  }

  if (Object.keys(body).length === 0) {
    return;
  }

  await client.request<unknown>(`/loyaltyObject/${encodeURIComponent(objectId)}`, {
    method: "PATCH",
    body
  });
};

const upsertTextModules = (
  existingModules: NonNullable<GoogleLoyaltyObject["textModulesData"]>,
  updates: Array<{ id: string; header: string; body: string }>
) => {
  const nextModules = [...existingModules];

  for (const update of updates) {
    const index = nextModules.findIndex((module) => module.id === update.id);

    if (index >= 0) {
      nextModules[index] = { ...nextModules[index], ...update };
    } else {
      nextModules.push(update);
    }
  }

  return nextModules;
};

export const getObject = async (objectId: string): Promise<LoyaltyObjectInput | null> => {
  assertIssuerScopedId(objectId, "objectId");

  try {
    const object = await getAuthenticatedClient().request<GoogleLoyaltyObject>(
      `/loyaltyObject/${encodeURIComponent(objectId)}`
    );

    return {
      objectId: object.id,
      classId: object.classId,
      accountName: object.accountName ?? "",
      accountId: object.accountId ?? object.id,
      loyaltyPointsLabel: object.loyaltyPoints?.label ?? "",
      loyaltyPointsBalance: parseLoyaltyPointsBalance(object.loyaltyPoints?.balance),
      tier: object.rewardsTier ?? object.classReference?.rewardsTier,
      state: object.state
    };
  } catch (error) {
    if (error instanceof GoogleWalletApiError && error.status === 404) {
      return null;
    }

    throw error;
  }
};

const toGoogleLoyaltyObjectBody = (input: LoyaltyObjectInput): GoogleLoyaltyObjectRequest => {
  const accountId = input.accountId ?? input.objectId;

  return {
    id: input.objectId,
    classId: input.classId,
    accountName: input.accountName,
    accountId,
    loyaltyPoints: {
      label: input.loyaltyPointsLabel,
      balance: {
        string: String(input.loyaltyPointsBalance)
      }
    },
    state: input.state ?? "ACTIVE",
    barcode: {
      type: "QR_CODE",
      value: accountId,
      alternateText: accountId
    },
    textModulesData: [
      // These reserved object-level IDs are referenced by LoyaltyClass.classTemplateInfo.
      {
        id: "points",
        header: input.loyaltyPointsLabel,
        body: String(input.loyaltyPointsBalance)
      },
      {
        id: "member_id",
        header: "Member ID",
        body: accountId
      },
      {
        id: "member_since",
        header: "Member Since",
        body: input.memberSince ?? "—"
      },
      ...(input.tier
        ? [
            {
              id: "tier",
              header: "Tier",
              body: input.tier
            }
          ]
        : [])
    ],
    // TODO: Verify object-level tier support against https://developers.google.com/wallet/retail/loyalty-cards/rest/v1/loyaltyclass before relying on this field in production.
    // As of now, this field has no effect when written on a LoyaltyObject; only LoyaltyClass.rewardsTier is real.
    rewardsTier: input.tier
  };
};

const toGoogleLoyaltyObjectPatchBody = (
  input: LoyaltyObjectInput
): GoogleLoyaltyObjectPatchRequest => {
  const { accountId, loyaltyPoints, state, barcode, textModulesData, rewardsTier } =
    toGoogleLoyaltyObjectBody(input);

  return {
    accountName: input.accountName,
    accountId,
    loyaltyPoints,
    state,
    barcode,
    textModulesData,
    rewardsTier
  };
};

const parseLoyaltyPointsBalance = (balance?: GoogleLoyaltyPointsBalance): number => {
  const value = balance?.string ?? balance?.int ?? balance?.double ?? 0;
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : 0;
};
