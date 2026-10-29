import { inspect } from "node:util";
import { randomUUID } from "node:crypto";

import { assertIssuerScopedId, getAuthenticatedClient, GoogleWalletApiError } from "./client";
import type { LoyaltyClassInput, LoyaltyMerchantLocationInput, LoyaltyMessageInput } from "./types";
import type { GoogleMessage } from "./objectService";

interface GoogleImage {
  sourceUri: {
    uri: string;
  };
  contentDescription?: {
    defaultValue: {
      language: string;
      value: string;
    };
  };
}

interface GoogleUri {
  uri: string;
  description?: string;
  id?: string;
}

interface GoogleLocalizedString {
  defaultValue: {
    language: string;
    value: string;
  };
}

export interface GoogleAppLinkData {
  webAppLinkInfo: {
    appTarget: {
      targetUri: GoogleUri;
    };
  };
  displayText: GoogleLocalizedString;
}

export interface GoogleLoyaltyClassLinkFields {
  appLinkData?: GoogleAppLinkData;
  linksModuleData?: {
    uris: GoogleUri[];
  };
}

interface GoogleLoyaltyClassRequest {
  id: string;
  issuerName: string;
  reviewStatus: "UNDER_REVIEW";
  programName: string;
  accountNameLabel: string;
  accountIdLabel: string;
  hexBackgroundColor?: string;
  programLogo?: GoogleImage;
  heroImage?: GoogleImage;
  homepageUri?: GoogleUri;
  textModulesData?: Array<{
    id?: string;
    header: string;
    body: string;
  }>;
  linksModuleData?: {
    uris: GoogleUri[];
  };
  appLinkData?: GoogleAppLinkData;
  rewardsTierLabel?: string;
  rewardsTier?: string;
  merchantLocations?: GoogleMerchantLocation[];
  messages?: GoogleMessage[];
  classTemplateInfo: {
    cardTemplateOverride: {
      cardRowTemplateInfos: GoogleCardRowTemplateInfo[];
    };
    detailsTemplateOverride?: {
      detailsItemInfos: Array<{
        item: GoogleTemplateItem;
      }>;
    };
  };
}

export interface GoogleClassBuildOptions {
  /**
   * Test-only: leave detailsTemplateOverride unset so Google's default details layout is used.
   * Production callers never pass this, so default behavior is unchanged.
   */
  omitDetailsTemplateOverride?: boolean;
}

interface GoogleAddMessageRequest {
  message: GoogleMessage;
}

interface GoogleMerchantLocation {
  address?: string;
  latitude: number;
  longitude: number;
}

export interface GoogleLoyaltyClassLocations {
  id: string;
  merchantLocations?: GoogleMerchantLocation[];
}

type GoogleCardRowTemplateInfo =
  | {
      oneItem: {
        item: GoogleTemplateItem;
      };
    }
  | {
      twoItems: {
        startItem: GoogleTemplateItem;
        endItem: GoogleTemplateItem;
      };
    }
  | {
      threeItems: {
        startItem: GoogleTemplateItem;
        middleItem: GoogleTemplateItem;
        endItem: GoogleTemplateItem;
      };
    };

interface GoogleTemplateItem {
  firstValue: {
    fields: Array<{
      fieldPath: string;
    }>;
  };
}

export const createOrUpdateClass = async (
  input: LoyaltyClassInput,
  options: GoogleClassBuildOptions = {}
): Promise<void> => {
  assertIssuerScopedId(input.classId, "classId");

  const client = getAuthenticatedClient();
  const classPath = `/loyaltyClass/${encodeURIComponent(input.classId)}`;
  const body = toGoogleLoyaltyClassBody(input, options);

  try {
    await client.request<unknown>(classPath);
    console.info("Google Wallet LoyaltyClass exists; PATCHing class", { classId: input.classId });

    const patchResponse = await client.requestWithResponse<unknown>(classPath, {
      method: "PATCH",
      body
    });

    logFullObject("Google Wallet LoyaltyClass PATCH response", {
      classId: input.classId,
      status: patchResponse.status,
      statusText: patchResponse.statusText,
      responseBody: patchResponse.body
    });

    await logVerifiedClassLinkFields(input.classId, body);
  } catch (error) {
    if (error instanceof GoogleWalletApiError && error.status === 404) {
      await client.request<unknown>("/loyaltyClass", {
        method: "POST",
        body
      });
      await logVerifiedClassLinkFields(input.classId, body);
      return;
    }

    throw error;
  }
};

export const getLoyaltyClassLinkFields = async (
  classId: string
): Promise<GoogleLoyaltyClassLinkFields> => {
  assertIssuerScopedId(classId, "classId");

  const classResponse = await getAuthenticatedClient().request<GoogleLoyaltyClassLinkFields>(
    `/loyaltyClass/${encodeURIComponent(classId)}`
  );

  return {
    appLinkData: classResponse.appLinkData,
    linksModuleData: classResponse.linksModuleData
  };
};

export const getLoyaltyClassLocations = async (
  classId: string
): Promise<GoogleLoyaltyClassLocations> => {
  assertIssuerScopedId(classId, "classId");

  return getAuthenticatedClient().request<GoogleLoyaltyClassLocations>(
    `/loyaltyClass/${encodeURIComponent(classId)}`
  );
};

export const addClassMessage = async (
  classId: string,
  message: Omit<LoyaltyMessageInput, "id"> & { id?: string }
): Promise<string> => {
  assertIssuerScopedId(classId, "classId");

  const messageId = message.id ?? randomUUID();
  const body: GoogleAddMessageRequest = {
    message: toGoogleMessage({ ...message, id: messageId })
  };

  await getAuthenticatedClient().request<unknown>(
    `/loyaltyClass/${encodeURIComponent(classId)}/addMessage`,
    {
      method: "POST",
      body
    }
  );

  return messageId;
};

export const removeClassMessage = async (classId: string, messageId: string): Promise<void> => {
  assertIssuerScopedId(classId, "classId");

  const client = getAuthenticatedClient();
  const existingClass = await client.request<{ messages?: GoogleMessage[] }>(
    `/loyaltyClass/${encodeURIComponent(classId)}`
  );
  const messages = (existingClass.messages ?? []).filter((message) => message.id !== messageId);

  await client.request<unknown>(`/loyaltyClass/${encodeURIComponent(classId)}`, {
    method: "PATCH",
    body: { messages }
  });
};

export const setClassLocations = async (
  classId: string,
  locations: LoyaltyMerchantLocationInput[]
): Promise<void> => {
  assertIssuerScopedId(classId, "classId");

  if (locations.length > 10) {
    throw new Error("Google Wallet MerchantLocations cannot exceed 10 per class");
  }

  await getAuthenticatedClient().request<unknown>(`/loyaltyClass/${encodeURIComponent(classId)}`, {
    method: "PATCH",
    body: {
      reviewStatus: "UNDER_REVIEW",
      merchantLocations: locations.map((location) => ({
        address: location.name,
        latitude: location.latitude,
        longitude: location.longitude
      }))
    }
  });
};

const toGoogleLoyaltyClassBody = (
  input: LoyaltyClassInput,
  options: GoogleClassBuildOptions = {}
): GoogleLoyaltyClassRequest => ({
  id: input.classId,
  issuerName: input.issuerName,
  reviewStatus: "UNDER_REVIEW",
  programName: input.programName,
  accountNameLabel: input.accountNameLabel ?? "Nombre de miembro",
  accountIdLabel: input.accountIdLabel ?? "N.º de miembro",
  hexBackgroundColor: input.hexBackgroundColor,
  ...(input.logoUrl ? { programLogo: toGoogleImage(input.logoUrl) } : {}),
  ...(input.heroImageUrl
    ? { heroImage: toGoogleImage(input.heroImageUrl, input.heroImageDescription) }
    : {}),
  homepageUri: {
    uri: input.homepageUrl
  },
  textModulesData: withDefaultCardTextModules(input.textModules, input.issuerName).map(
    (module) => ({
      id: module.id,
      header: module.header,
      body: module.body
    })
  ),
  linksModuleData: input.linkModules
    ? {
        uris: input.linkModules.map((linkModule) => ({
          id: linkModule.tag,
          description: linkModule.description ?? linkModule.tag,
          uri: linkModule.url
        }))
      }
    : undefined,
  appLinkData: input.appLink
    ? {
        webAppLinkInfo: {
          appTarget: {
            targetUri: {
              uri: input.appLink.url,
              description: input.appLink.description ?? input.appLink.displayText
            }
          }
        },
        displayText: {
          defaultValue: {
            language: "en-US",
            value: input.appLink.displayText
          }
        }
      }
    : undefined,
  rewardsTierLabel: input.rewardsTierLabel,
  rewardsTier: input.rewardsTier,
  classTemplateInfo: buildClassTemplateInfo(options)
});

const withDefaultCardTextModules = (
  modules: LoyaltyClassInput["textModules"] = [],
  clinicName: string
): NonNullable<LoyaltyClassInput["textModules"]> => {
  const hasModule = (id: string): boolean => modules.some((module) => module.id === id);

  return [
    ...(!hasModule("clinic") ? [{ id: "clinic", header: "Centro", body: clinicName }] : []),
    ...(!hasModule("benefit_cta")
      ? [{ id: "benefit_cta", header: "Beneficio", body: "Ver beneficios" }]
      : []),
    ...modules
  ];
};

const toGoogleImage = (uri: string, description?: string): GoogleImage => ({
  sourceUri: {
    uri
  },
  ...(description
    ? {
        contentDescription: {
          defaultValue: {
            language: "es",
            value: description
          }
        }
      }
    : {})
});

const toGoogleMessage = (message: LoyaltyMessageInput): GoogleMessage => ({
  id: message.id,
  header: message.header,
  body: message.body,
  messageType: message.notify ? "TEXT_AND_NOTIFY" : "TEXT"
});

/**
 * Production detailsTemplateOverride field paths, in display order.
 * Shared with scripts so one-off class patches stay in sync with the builder.
 */
export const PRODUCTION_DETAILS_TEMPLATE_FIELD_PATHS = [
  "class.textModulesData['clinic']",
  "object.textModulesData['member_id']",
  "object.textModulesData['member_since']",
  "object.textModulesData['rewards']",
  // Per member: a pending x2 (a waiting perk, or a referred member's first visit). Absent from the
  // object when nothing is pending, where the item simply does not render.
  "object.textModulesData['boost']",
  // Per member: the benefits of their current tier, for a clinic whose programme owns them.
  // Absent from the object of any other clinic, where the item simply does not render.
  "object.textModulesData['tierbenefits']",
  "class.textModulesData['benefits']",
  "object.accountName",
  "object.accountId",
  "class.textModulesData['info']"
] as const;

/**
 * Messages items appended to the production details template so TEXT_AND_NOTIFY messages
 * render on the pass details view (confirmed on test class tpl_test_default).
 */
export const MESSAGE_DETAILS_FIELD_PATHS = ["class.messages", "object.messages"] as const;

/**
 * Builds classTemplateInfo exactly as the production class body does.
 * Shared with scripts so one-off class patches stay in sync with the builder.
 */
export const buildClassTemplateInfo = (
  options: GoogleClassBuildOptions = {}
): GoogleLoyaltyClassRequest["classTemplateInfo"] => ({
  cardTemplateOverride: {
    cardRowTemplateInfos: [
      {
        twoItems: {
          startItem: toTemplateItem("object.accountName"),
          endItem: toTemplateItem("object.textModulesData['points']")
        }
      },
      {
        threeItems: {
          startItem: toTemplateItem("object.textModulesData['member_id']"),
          middleItem: toTemplateItem("object.textModulesData['tier']"),
          endItem: toTemplateItem("class.textModulesData['benefit_cta']")
        }
      },
      // How many rewards are waiting: the stamp-card count, on the front of the card. Absent
      // from objects of a clinic with no programme, where the row simply does not render.
      {
        oneItem: {
          item: toTemplateItem("object.secondaryLoyaltyPoints")
        }
      }
    ]
  },
  ...(options.omitDetailsTemplateOverride
    ? {}
    : {
        detailsTemplateOverride: {
          detailsItemInfos: [
            ...PRODUCTION_DETAILS_TEMPLATE_FIELD_PATHS.map((fieldPath) => ({
              item: toTemplateItem(fieldPath)
            })),
            ...MESSAGE_DETAILS_FIELD_PATHS.map((fieldPath) => ({
              item: toTemplateItem(fieldPath)
            }))
          ]
        }
      })
});

export const toTemplateItem = (fieldPath: string): GoogleTemplateItem => ({
  firstValue: {
    fields: [
      {
        fieldPath
      }
    ]
  }
});

const logVerifiedClassLinkFields = async (
  classId: string,
  expectedBody: GoogleLoyaltyClassRequest
): Promise<void> => {
  const classPath = `/loyaltyClass/${encodeURIComponent(classId)}`;
  const getResponse =
    await getAuthenticatedClient().requestWithResponse<GoogleLoyaltyClassLinkFields>(classPath);
  const actualFields: GoogleLoyaltyClassLinkFields = {
    appLinkData: getResponse.body.appLinkData,
    linksModuleData: getResponse.body.linksModuleData
  };

  logFullObject("Google Wallet LoyaltyClass GET link-field verification", {
    classId,
    status: getResponse.status,
    statusText: getResponse.statusText,
    appLinkData: actualFields.appLinkData,
    linksModuleData: actualFields.linksModuleData
  });

  const mismatches = getClassLinkFieldMismatches(expectedBody, actualFields);

  if (mismatches.length > 0) {
    logFullObject(
      "Google Wallet LoyaltyClass link fields were not persisted as sent",
      {
        classId,
        mismatches,
        expected: {
          appLinkData: expectedBody.appLinkData,
          linksModuleData: expectedBody.linksModuleData
        },
        actual: actualFields
      },
      "warn"
    );
  }
};

const logFullObject = (message: string, value: unknown, level: "info" | "warn" = "info"): void => {
  console[level](message, inspect(value, { colors: false, depth: null, maxArrayLength: null }));
};

const getClassLinkFieldMismatches = (
  expectedBody: GoogleLoyaltyClassRequest,
  actualFields: GoogleLoyaltyClassLinkFields
): string[] => {
  const mismatches: string[] = [];
  const expectedAppLink = expectedBody.appLinkData;
  const actualAppLink = actualFields.appLinkData;

  if (
    expectedAppLink?.displayText.defaultValue.value !==
    actualAppLink?.displayText?.defaultValue?.value
  ) {
    mismatches.push("appLinkData.displayText.defaultValue.value");
  }

  if (
    expectedAppLink?.displayText.defaultValue.language !==
    actualAppLink?.displayText?.defaultValue?.language
  ) {
    mismatches.push("appLinkData.displayText.defaultValue.language");
  }

  if (
    expectedAppLink?.webAppLinkInfo.appTarget.targetUri.uri !==
    actualAppLink?.webAppLinkInfo?.appTarget?.targetUri?.uri
  ) {
    mismatches.push("appLinkData.webAppLinkInfo.appTarget.targetUri.uri");
  }

  if (
    expectedAppLink?.webAppLinkInfo.appTarget.targetUri.description !==
    actualAppLink?.webAppLinkInfo?.appTarget?.targetUri?.description
  ) {
    mismatches.push("appLinkData.webAppLinkInfo.appTarget.targetUri.description");
  }

  const expectedUris = expectedBody.linksModuleData?.uris ?? [];
  const actualUris = actualFields.linksModuleData?.uris ?? [];

  if (expectedUris.length !== actualUris.length) {
    mismatches.push("linksModuleData.uris.length");
  }

  expectedUris.forEach((expectedUri, index) => {
    const actualUri = actualUris[index];

    if (expectedUri.uri !== actualUri?.uri) {
      mismatches.push(`linksModuleData.uris[${index}].uri`);
    }

    if (expectedUri.description !== actualUri?.description) {
      mismatches.push(`linksModuleData.uris[${index}].description`);
    }
  });

  return mismatches;
};
