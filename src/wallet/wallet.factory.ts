import { getAppleWalletConfig } from "../config/apple-wallet.config";
import { PassBuilder } from "./engine/pass-builder.interface";
import { ApplePassBuilder } from "./providers/apple/apple-pass.builder";
import { resolvePassModelDirectory } from "./providers/apple/apple-pass.model";

export type WalletPlatform = "apple" | "google";

/**
 * Builds the Apple pass builder from configuration.
 *
 * Superseded in spirit by WalletPassProvider and the provider registry, which resolve an
 * adapter by capability rather than by a platform string. Kept only because
 * WalletPassEngine.createPass still calls it; the registry replaces both.
 */
export const getPassBuilder = (platform: WalletPlatform): PassBuilder => {
  if (platform === "google") {
    throw new Error("Not implemented");
  }

  const config = getAppleWalletConfig();

  return new ApplePassBuilder({
    passTypeIdentifier: config.passTypeIdentifier,
    teamIdentifier: config.teamIdentifier,
    organizationName: config.organizationName,
    modelDirectory: resolvePassModelDirectory(config.modelDirectory),
    certificates: config.certificates
  });
};
