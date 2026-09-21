import { existsSync } from "node:fs";
import path from "node:path";

import { WalletPassSigningError } from "../../../common/errors/wallet.errors";
import { AppleWalletCertificates } from "../../../config/apple-wallet.config";
import { LoyaltyCard } from "../../engine/loyalty-card";
import { BuiltPass, PassBuilder, PassUpdateBinding } from "../../engine/pass-builder.interface";
import { buildStoreCardFields } from "./apple-pass.fields";
import { PASS_TRANSLATIONS } from "./apple-pass.strings";
import { deriveAppleTheme } from "./apple-pass.theme";
import { PKPassInstance, loadPasskit } from "./passkit";

export interface ApplePassBuilderOptions {
  passTypeIdentifier: string;
  teamIdentifier: string;
  organizationName: string;
  modelDirectory: string;
  certificates: AppleWalletCertificates;
}

const PASS_STYLE = "storeCard";

export class ApplePassBuilder implements PassBuilder {
  constructor(private readonly options: ApplePassBuilderOptions) {}

  async build(data: LoyaltyCard, updates?: PassUpdateBinding): Promise<BuiltPass> {
    this.assertModelIsUsable();

    const buffer = await this.sign(data, updates);

    return {
      buffer,
      fileName: `${data.serialNumber}.pkpass`,
      contentType: "application/vnd.apple.pkpass",
      serialNumber: data.serialNumber
    };
  }

  /**
   * passkit-generator only logs a warning for a missing icon while iOS rejects the pass
   * outright, so the icon is checked here instead of trusting the library.
   */
  private assertModelIsUsable(): void {
    const { modelDirectory } = this.options;

    if (!existsSync(modelDirectory)) {
      throw new WalletPassSigningError(
        `The Apple Wallet pass model directory is missing. Expected it at ${modelDirectory}. ` +
          `If this is a production build, check that the pass assets were copied into dist.`
      );
    }

    if (!existsSync(path.join(modelDirectory, "icon.png"))) {
      throw new WalletPassSigningError(
        `The Apple Wallet pass model at ${modelDirectory} has no icon.png. Apple rejects a ` +
          `pass without one.`
      );
    }
  }

  private async sign(data: LoyaltyCard, updates?: PassUpdateBinding): Promise<Buffer> {
    const { PKPass, PassType } = await loadPasskit();
    const theme = deriveAppleTheme(data.template.backgroundColor);

    let pass: PKPassInstance;

    try {
      pass = await PKPass.from(
        {
          model: this.options.modelDirectory,
          certificates: this.certificates()
        },
        {
          serialNumber: data.serialNumber,
          passTypeIdentifier: this.options.passTypeIdentifier,
          teamIdentifier: this.options.teamIdentifier,
          organizationName: this.options.organizationName,
          // Apple requires a description for VoiceOver; the library does not enforce it.
          description: `${data.clinic.name} · ${data.template.programName}`,
          logoText: data.clinic.name,
          sharingProhibited: true,
          backgroundColor: theme.backgroundColor,
          foregroundColor: theme.foregroundColor,
          labelColor: theme.labelColor,
          // Both or neither. Apple ignores a webServiceURL with no token and rejects a
          // token with no URL, and a pass carrying one of them is a pass that silently
          // never updates — the failure mode worth designing out rather than debugging.
          ...(updates
            ? {
                webServiceURL: updates.webServiceUrl,
                authenticationToken: updates.authenticationToken
              }
            : {})
        }
      );
    } catch (error) {
      throw new WalletPassSigningError("Could not assemble the Apple Wallet pass.", error);
    }

    this.applyFields(pass, data, PassType);

    pass.setBarcodes({
      message: data.redemptionCode,
      format: "PKBarcodeFormatQR",
      messageEncoding: "iso-8859-1",
      altText: data.redemptionCode
    });

    for (const [language, translations] of Object.entries(PASS_TRANSLATIONS)) {
      pass.localize(language, translations);
    }

    try {
      return pass.getAsBuffer();
    } catch (error) {
      // node-forge returns null rather than throwing when the key passphrase is wrong, and
      // the resulting TypeError surfaces here with nothing pointing at the cause. The
      // certificate preflight is what normally prevents that, so say so.
      throw new WalletPassSigningError(
        "Could not sign the Apple Wallet pass. This usually means the signing certificate " +
          "and key do not match or the key passphrase is wrong.",
        error
      );
    }
  }

  /**
   * The model's `"storeCard": {}` makes passkit-generator create the pass type on import;
   * this finds it rather than creating a second one, which would be ignored at export.
   */
  private applyFields(
    pass: PKPassInstance,
    data: LoyaltyCard,
    PassType: Awaited<ReturnType<typeof loadPasskit>>["PassType"]
  ): void {
    let storeCard = pass.types.find((candidate) => candidate.type === PASS_STYLE);

    if (!storeCard) {
      storeCard = new PassType(PASS_STYLE);
      pass.types.push(storeCard);
    }

    const fields = buildStoreCardFields(data);

    storeCard.headerFields.push(...fields.headerFields);
    storeCard.primaryFields.push(...fields.primaryFields);
    storeCard.secondaryFields.push(...fields.secondaryFields);
    storeCard.auxiliaryFields.push(...fields.auxiliaryFields);
    storeCard.backFields.push(...fields.backFields);
  }

  /**
   * An empty passphrase is not the same as no passphrase: the library's schema rejects an
   * empty string outright, so the property is omitted when there is nothing to send.
   */
  private certificates(): AppleWalletCertificates {
    const { wwdr, signerCert, signerKey, signerKeyPassphrase } = this.options.certificates;

    return signerKeyPassphrase
      ? { wwdr, signerCert, signerKey, signerKeyPassphrase }
      : { wwdr, signerCert, signerKey };
  }
}
