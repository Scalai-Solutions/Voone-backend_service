import { randomUUID } from "node:crypto";

import { assertIssuerScopedId, getAuthenticatedClient, GoogleWalletApiError } from "./client";
import type {
  LoyaltyMessageInput,
  LoyaltyObjectInput,
  LoyaltyObjectPatch,
  LoyaltyObjectState
} from "./types";

/** The reserved object-level IDs and labels the class template points at for rewards. */
export const REWARDS_MODULE_ID = "rewards";
export const REWARDS_MODULE_HEADER = "Recompensas disponibles";
export const REWARDS_COUNT_LABEL = "Regalos";
/** The per-member module the class details point at for a clinic whose programme owns the benefits. */
export const TIER_BENEFITS_MODULE_ID = "tierbenefits";
export const TIER_BENEFITS_MODULE_HEADER = "Beneficios de tu nivel";

interface GoogleSecondaryLoyaltyPoints {
  label: string;
  balance: { int: number };
}

const toSecondaryPoints = (count: number): GoogleSecondaryLoyaltyPoints => ({
  label: REWARDS_COUNT_LABEL,
  balance: { int: count }
});

interface GoogleLoyaltyPointsBalance {
  string?: string;
  int?: number;
  double?: number;
}

interface GoogleLoyaltyPoints {
  label?: string;
  balance?: GoogleLoyaltyPointsBalance;
}

export interface GoogleMessage {
  id?: string;
  header: string;
  body: string;
  messageType?: "TEXT" | "TEXT_AND_NOTIFY";
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
  secondaryLoyaltyPoints?: GoogleSecondaryLoyaltyPoints;
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
  secondaryLoyaltyPoints?: GoogleSecondaryLoyaltyPoints;
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
  secondaryLoyaltyPoints?: GoogleSecondaryLoyaltyPoints;
  state?: LoyaltyObjectState;
  barcode?: GoogleBarcode;
  textModulesData?: Array<{
    id: string;
    header: string;
    body: string;
  }>;
  rewardsTier?: string;
  messages?: GoogleMessage[];
  notifyPreference?: "notifyOnUpdate";
}

interface GoogleAddMessageRequest {
  message: GoogleMessage;
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

  if (
    patch.loyaltyPointsBalance !== undefined ||
    patch.tier !== undefined ||
    patch.rewards !== undefined ||
    patch.tierBenefits !== undefined
  ) {
    // A PATCH of textModulesData REPLACES the whole array, so the object is read first and the
    // changed modules are merged into what it holds: nothing the object already carries is lost.
    const existingObject = await client.request<GoogleLoyaltyObject>(
      `/loyaltyObject/${encodeURIComponent(objectId)}`
    );
    const existingTextModules = existingObject.textModulesData ?? [];
    const existingHeaderFor = (id: string, fallback: string): string =>
      existingTextModules.find((module) => module.id === id)?.header ?? fallback;

    const merged = upsertTextModules(existingTextModules, [
      ...(patch.loyaltyPointsBalance !== undefined
        ? [
            {
              id: "points",
              header: existingObject.loyaltyPoints?.label ?? existingHeaderFor("points", "Puntos"),
              body: String(patch.loyaltyPointsBalance)
            }
          ]
        : []),
      ...(patch.tier !== undefined
        ? [{ id: "tier", header: existingHeaderFor("tier", "Nivel"), body: patch.tier }]
        : []),
      ...(patch.rewards !== undefined
        ? [{ id: REWARDS_MODULE_ID, header: REWARDS_MODULE_HEADER, body: patch.rewards.text }]
        : []),
      ...(patch.tierBenefits
        ? [
            {
              id: TIER_BENEFITS_MODULE_ID,
              header: TIER_BENEFITS_MODULE_HEADER,
              body: patch.tierBenefits.text
            }
          ]
        : [])
    ]);
    // The merge keeps modules it does not know, so a stale tier benefits module is dropped by name.
    const next =
      patch.tierBenefits === null
        ? merged.filter((module) => module.id !== TIER_BENEFITS_MODULE_ID)
        : merged;
    const onlyRemoval =
      patch.loyaltyPointsBalance === undefined &&
      patch.tier === undefined &&
      patch.rewards === undefined;

    // A removal with nothing to remove writes nothing: most clinics have no such module.
    if (!onlyRemoval || next.length !== existingTextModules.length) {
      body.textModulesData = next;
    }
  }

  if (patch.rewards !== undefined) {
    body.secondaryLoyaltyPoints = toSecondaryPoints(patch.rewards.count);
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

  if (patch.notify) {
    body.notifyPreference = "notifyOnUpdate";
  }

  if (Object.keys(body).length === 0) {
    return;
  }

  await client.request<unknown>(`/loyaltyObject/${encodeURIComponent(objectId)}`, {
    method: "PATCH",
    body
  });
};

export const addObjectMessage = async (
  objectId: string,
  message: Omit<LoyaltyMessageInput, "id"> & { id?: string }
): Promise<string> => {
  assertIssuerScopedId(objectId, "objectId");

  const messageId = message.id ?? randomUUID();
  const body: GoogleAddMessageRequest = {
    message: toGoogleMessage({ ...message, id: messageId })
  };

  await getAuthenticatedClient().request<unknown>(
    `/loyaltyObject/${encodeURIComponent(objectId)}/addMessage`,
    {
      method: "POST",
      body
    }
  );

  return messageId;
};

export const removeObjectMessage = async (objectId: string, messageId: string): Promise<void> => {
  assertIssuerScopedId(objectId, "objectId");

  const client = getAuthenticatedClient();
  const existingObject = await client.request<GoogleLoyaltyObject>(
    `/loyaltyObject/${encodeURIComponent(objectId)}`
  );
  const messages = (existingObject.messages ?? []).filter((message) => message.id !== messageId);

  await client.request<unknown>(`/loyaltyObject/${encodeURIComponent(objectId)}`, {
    method: "PATCH",
    body: { messages }
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

const toGoogleMessage = (message: LoyaltyMessageInput): GoogleMessage => ({
  id: message.id,
  header: message.header,
  body: message.body,
  messageType: message.notify ? "TEXT_AND_NOTIFY" : "TEXT"
});

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
    ...(input.rewards ? { secondaryLoyaltyPoints: toSecondaryPoints(input.rewards.count) } : {}),
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
        header: "N.º de miembro",
        body: accountId
      },
      {
        id: "member_since",
        header: "Miembro desde",
        body: input.memberSince ?? "—"
      },
      {
        id: "tier",
        header: input.tierLabel ?? "Nivel",
        body: input.tier ?? "—"
      },
      ...(input.rewards
        ? [{ id: REWARDS_MODULE_ID, header: REWARDS_MODULE_HEADER, body: input.rewards.text }]
        : []),
      ...(input.tierBenefits
        ? [
            {
              id: TIER_BENEFITS_MODULE_ID,
              header: TIER_BENEFITS_MODULE_HEADER,
              body: input.tierBenefits.text
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
  const {
    accountId,
    loyaltyPoints,
    secondaryLoyaltyPoints,
    state,
    barcode,
    textModulesData,
    rewardsTier
  } = toGoogleLoyaltyObjectBody(input);

  return {
    accountName: input.accountName,
    accountId,
    loyaltyPoints,
    secondaryLoyaltyPoints,
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
