import { inspect } from "node:util";

import { assertIssuerScopedId, getAuthenticatedClient, GoogleWalletApiError } from "./client";
import type { LoyaltyClassInput } from "./types";

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
  classTemplateInfo: {
    cardTemplateOverride: {
      cardRowTemplateInfos: GoogleCardRowTemplateInfo[];
    };
    detailsTemplateOverride: {
      detailsItemInfos: Array<{
        item: GoogleTemplateItem;
      }>;
    };
  };
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

export const createOrUpdateClass = async (input: LoyaltyClassInput): Promise<void> => {
  assertIssuerScopedId(input.classId, "classId");

  const client = getAuthenticatedClient();
  const classPath = `/loyaltyClass/${encodeURIComponent(input.classId)}`;
  const body = toGoogleLoyaltyClassBody(input);

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

const toGoogleLoyaltyClassBody = (input: LoyaltyClassInput): GoogleLoyaltyClassRequest => ({
  id: input.classId,
  issuerName: input.issuerName,
  reviewStatus: "UNDER_REVIEW",
  programName: input.programName,
  accountNameLabel: input.accountNameLabel ?? "Nombre del miembro",
  accountIdLabel: input.accountIdLabel ?? "ID de miembro",
  hexBackgroundColor: input.hexBackgroundColor,
  programLogo: toGoogleImage(input.logoUrl),
  heroImage: toGoogleImage(input.heroImageUrl, input.heroImageDescription),
  homepageUri: {
    uri: input.homepageUrl
  },
  // The template expects benefits and info as shared class modules. Points and tier live on each object.
  textModulesData: input.textModules?.map((module) => ({
    id: module.id,
    header: module.header,
    body: module.body
  })),
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
  classTemplateInfo: {
    cardTemplateOverride: {
      cardRowTemplateInfos: [
        {
          oneItem: {
            item: toTemplateItem("object.accountName")
          }
        },
        {
          twoItems: {
            startItem: toTemplateItem("class.textModulesData['clinic']"),
            endItem: toTemplateItem("object.textModulesData['member_id']")
          }
        },
        {
          threeItems: {
            startItem: toTemplateItem("object.textModulesData['member_since']"),
            middleItem: toTemplateItem("object.textModulesData['tier']"),
            endItem: toTemplateItem("object.textModulesData['points']")
          }
        }
      ]
    },
    detailsTemplateOverride: {
      detailsItemInfos: [
        { item: toTemplateItem("class.textModulesData['clinic']") },
        { item: toTemplateItem("object.textModulesData['member_id']") },
        { item: toTemplateItem("object.textModulesData['member_since']") },
        { item: toTemplateItem("class.textModulesData['benefits']") },
        { item: toTemplateItem("object.accountName") },
        { item: toTemplateItem("object.accountId") },
        { item: toTemplateItem("class.textModulesData['info']") }
      ]
    }
  }
});

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

const toTemplateItem = (fieldPath: string): GoogleTemplateItem => ({
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
