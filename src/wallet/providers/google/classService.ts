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
    await client.request<unknown>(classPath, {
      method: "PATCH",
      body
    });
  } catch (error) {
    if (error instanceof GoogleWalletApiError && error.status === 404) {
      await client.request<unknown>("/loyaltyClass", {
        method: "POST",
        body
      });
      return;
    }

    throw error;
  }
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
          description: linkModule.tag,
          uri: linkModule.url
        }))
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
