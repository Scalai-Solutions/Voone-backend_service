import { WalletPassDataError } from "../../common/errors/wallet.errors";
import type {
  ClinicTemplateWithRelations,
  WalletClassSyncResult
} from "../../modules/templates/templates.repository";
import { WalletPlatform, getPassBuilder } from "../wallet.factory";
import { loyaltyCardSchema } from "./loyalty-card";
import { BuiltPass } from "./pass-builder.interface";
import { WalletProviderRegistry } from "./wallet-provider.registry";

/**
 * Provider-independent orchestration.
 *
 * The two halves here are deliberately different shapes, because the providers are:
 * Google's classes live on Google's servers and are created once per clinic template,
 * while an Apple pass is a signed file built per member. Both sit behind this engine so
 * callers do not reach for a vendor SDK directly.
 */
export class WalletPassEngine {
  constructor(private readonly registry = new WalletProviderRegistry()) {}

  async createClassForTemplate(
    template: ClinicTemplateWithRelations
  ): Promise<WalletClassSyncResult[]> {
    const program = {
      templateId: template.id,
      clinicName: template.clinic.name,
      template: {
        programName: template.programName,
        backgroundColor: template.hexBackgroundColor,
        logoUrl: template.logoUrl ?? undefined,
        heroImageUrl: template.heroImageUrl ?? undefined,
        websiteUrl: template.websiteUrl ?? undefined,
        appointmentUrl: template.appointmentUrl ?? undefined,
        appLinkText: template.appLinkText ?? undefined,
        appLinkDescription: template.appLinkDescription ?? undefined,
        pointsLabel: template.pointsLabel,
        tierLabel: template.tierLabel,
        benefitsText: template.benefitsText,
        infoText: template.infoText
      }
    };

    const refs = await Promise.all(
      this.registry.enabled().map((provider) => provider.provisionProgram(program))
    );

    return refs.map((ref) => ({ provider: ref.provider, externalClassId: ref.externalId }));
  }

  /** Validate the data, then delegate to the platform's builder. */
  async createPass(platform: WalletPlatform, data: unknown): Promise<BuiltPass> {
    const parsed = loyaltyCardSchema.safeParse(data);

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new WalletPassDataError(`Invalid loyalty pass data: ${details}`);
    }

    return getPassBuilder(platform).build(parsed.data);
  }

  updatePass(): never {
    throw new Error("Not implemented");
  }

  deletePass(): never {
    throw new Error("Not implemented");
  }
}

export const walletPassEngine = new WalletPassEngine();
