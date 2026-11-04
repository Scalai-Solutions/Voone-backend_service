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
/** The per-member module that says the next visit earns double. Present only while it does. */
export const BOOST_MODULE_ID = "boost";
export const BOOST_MODULE_HEADER = "Puntos dobles";
/** The member's next reward and the distance to it, on the front of the card beside the tier. */
export const NEXT_REWARD_MODULE_ID = "next_reward";
export const NEXT_REWARD_MODULE_HEADER = "Próxima recompensa";
/** The per-member module with the member's code and sign-up link, to recommend the clinic. */
export const REFERRAL_MODULE_ID = "referral";
export const REFERRAL_MODULE_HEADER = "Recomienda";

/**
 * How many rewards are waiting, on the front of the card. A text module, not secondaryLoyaltyPoints:
 * Google appends its own "puntos" to anything in a points field ("0 premios puntos"), and a text
 * module is shown exactly as written.
 */
export const REWARDS_COUNT_MODULE_ID = "rewards_count";

const toRewardsCountModule = (count: number) => ({
  id: REWARDS_COUNT_MODULE_ID,
  header: REWARDS_COUNT_LABEL,
  body: `${count} ${count === 1 ? "premio" : "premios"}`
});

/** The id of the referral link on the object, referenced by the class details template. */
export const REFERRAL_LINK_ID = "referral";
export const REFERRAL_LINK_TEXT = "Compartir mi enlace";

interface GoogleObjectLinks {
  uris: Array<{ id: string; uri: string; description: string }>;
}

// Google does not make a URL inside a text module tappable or copyable; a links-module uri is both.
const toReferralLinks = (url: string | undefined): GoogleObjectLinks => ({
  uris: url ? [{ id: REFERRAL_LINK_ID, uri: url, description: REFERRAL_LINK_TEXT }] : []
});

const toBarcode = (accountId: string, value?: string): GoogleBarcode => ({
  type: "QR_CODE",
  value: value ?? accountId,
  // Only the label under the QR, as on Apple: the short member number reception reads aloud.
  alternateText: accountId
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
  state?: LoyaltyObjectState;
  textModulesData?: Array<{
    id: string;
    header: string;
    body: string;
  }>;
  messages?: GoogleMessage[];
  linksModuleData?: { uris?: unknown[] };
  /** Set by Google once someone has saved the pass to their wallet. */
  hasUsers?: boolean;
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
  linksModuleData: GoogleObjectLinks;
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
  linksModuleData?: GoogleObjectLinks;
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
    patch.tierBenefits !== undefined ||
    patch.boost !== undefined ||
    patch.nextReward !== undefined ||
    patch.referral !== undefined
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
        ? [
            { id: REWARDS_MODULE_ID, header: REWARDS_MODULE_HEADER, body: patch.rewards.text },
            toRewardsCountModule(patch.rewards.count)
          ]
        : []),
      ...(patch.tierBenefits
        ? [
            {
              id: TIER_BENEFITS_MODULE_ID,
              header: TIER_BENEFITS_MODULE_HEADER,
              body: patch.tierBenefits.text
            }
          ]
        : []),
      ...(patch.boost
        ? [{ id: BOOST_MODULE_ID, header: BOOST_MODULE_HEADER, body: patch.boost.text }]
        : []),
      ...(patch.nextReward
        ? [
            {
              id: NEXT_REWARD_MODULE_ID,
              header: NEXT_REWARD_MODULE_HEADER,
              body: patch.nextReward.text
            }
          ]
        : []),
      ...(patch.referral
        ? [{ id: REFERRAL_MODULE_ID, header: REFERRAL_MODULE_HEADER, body: patch.referral.text }]
        : [])
    ]);
    // The merge keeps modules it does not know, so a stale optional module is dropped by name.
    const staleIds = [
      ...(patch.tierBenefits === null ? [TIER_BENEFITS_MODULE_ID] : []),
      ...(patch.boost === null ? [BOOST_MODULE_ID] : []),
      ...(patch.nextReward === null ? [NEXT_REWARD_MODULE_ID] : []),
      ...(patch.referral === null ? [REFERRAL_MODULE_ID] : [])
    ];
    const next = merged.filter((module) => !staleIds.includes(module.id));

    // Unchanged modules write nothing: most syncs repeat what the card already says (the same next
    // reward, a removal with nothing to remove), and a write per sync would be Google quota spent
    // for no change on the pass.
    if (JSON.stringify(next) !== JSON.stringify(existingTextModules)) {
      body.textModulesData = next;
    }

    // The object's only links are the referral one, so the whole list is written, or cleared
    // when it holds one; a card that never had a referral link costs no write.
    if (patch.referral || (patch.referral === null && existingObject.linksModuleData?.uris?.length)) {
      body.linksModuleData = toReferralLinks(patch.referral?.url);
    }
  }

  if (patch.accountId !== undefined) {
    body.accountId = patch.accountId;
    body.barcode = toBarcode(patch.accountId, patch.barcodeValue);
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

  const response = await getAuthenticatedClient().request<GoogleAddMessageResponse>(
    `/loyaltyObject/${encodeURIComponent(objectId)}/addMessage`,
    {
      method: "POST",
      body
    }
  );
  await trimPassMessages(`/loyaltyObject/${encodeURIComponent(objectId)}`, response);

  return messageId;
};

/** How many messages a pass keeps per list (class broadcasts, object messages). */
export const MAX_PASS_MESSAGES = 4;

export interface GoogleAddMessageResponse {
  resource?: { messages?: GoogleMessage[] };
}

/**
 * addMessage only appends, so drop all but the newest messages (Google keeps them in send order).
 * Never throws: the message is already out, and a retry would send it again.
 * shortcut: two sends racing on one pass may trim from a stale list, add a GET + version check if
 * that ever happens.
 */
export const trimPassMessages = async (
  path: string,
  response: GoogleAddMessageResponse | undefined
): Promise<void> => {
  const messages = response?.resource?.messages ?? [];
  if (messages.length <= MAX_PASS_MESSAGES) return;

  try {
    await getAuthenticatedClient().request<unknown>(path, {
      method: "PATCH",
      body: { messages: messages.slice(-MAX_PASS_MESSAGES) }
    });
  } catch (error) {
    console.error("[wallet] Google pass messages were not trimmed", { path, error });
  }
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

/**
 * Whether a member has saved this pass to their Google Wallet: the platform sets `hasUsers` on
 * the object the moment someone does. Unlike the save callback, this needs no public URL, so it
 * works on every deployment. False for an object Google does not know.
 */
export const objectHasUsers = async (objectId: string): Promise<boolean> => {
  assertIssuerScopedId(objectId, "objectId");

  try {
    const object = await getAuthenticatedClient().request<GoogleLoyaltyObject>(
      `/loyaltyObject/${encodeURIComponent(objectId)}`
    );

    return object.hasUsers === true;
  } catch (error) {
    if (error instanceof GoogleWalletApiError && error.status === 404) return false;

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
    barcode: toBarcode(accountId, input.barcodeValue),
    textModulesData: [
      // These reserved object-level IDs are referenced by LoyaltyClass.classTemplateInfo.
      {
        id: "points",
        header: input.loyaltyPointsLabel,
        body: String(input.loyaltyPointsBalance)
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
        ? [
            { id: REWARDS_MODULE_ID, header: REWARDS_MODULE_HEADER, body: input.rewards.text },
            toRewardsCountModule(input.rewards.count)
          ]
        : []),
      ...(input.tierBenefits
        ? [
            {
              id: TIER_BENEFITS_MODULE_ID,
              header: TIER_BENEFITS_MODULE_HEADER,
              body: input.tierBenefits.text
            }
          ]
        : []),
      ...(input.boost
        ? [{ id: BOOST_MODULE_ID, header: BOOST_MODULE_HEADER, body: input.boost.text }]
        : []),
      ...(input.nextReward
        ? [
            {
              id: NEXT_REWARD_MODULE_ID,
              header: NEXT_REWARD_MODULE_HEADER,
              body: input.nextReward.text
            }
          ]
        : []),
      ...(input.referral
        ? [{ id: REFERRAL_MODULE_ID, header: REFERRAL_MODULE_HEADER, body: input.referral.text }]
        : [])
    ],
    linksModuleData: toReferralLinks(input.referral?.url),
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
    state,
    barcode,
    textModulesData,
    linksModuleData,
    rewardsTier
  } = toGoogleLoyaltyObjectBody(input);

  return {
    accountName: input.accountName,
    accountId,
    loyaltyPoints,
    state,
    barcode,
    textModulesData,
    linksModuleData,
    rewardsTier
  };
};

const parseLoyaltyPointsBalance = (balance?: GoogleLoyaltyPointsBalance): number => {
  const value = balance?.string ?? balance?.int ?? balance?.double ?? 0;
  const parsedValue = Number(value);

  return Number.isFinite(parsedValue) ? parsedValue : 0;
};
