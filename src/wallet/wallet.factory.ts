import { getAppleWalletConfig } from "../config/apple-wallet.config";
import { PassBuilder } from "./engine/pass-builder.interface";
import { WalletProvider } from "./engine/wallet-provider.interface";
import { ApplePassBuilder } from "./providers/apple/apple-pass.builder";
import { resolvePassModelDirectory } from "./providers/apple/apple-pass.model";

export type WalletPlatform = "apple" | "google";

// This will route wallet operations to the correct provider implementation.
export const getWalletProvider = (platform: WalletPlatform): WalletProvider => {
  void platform;

  throw new Error("Not implemented");
};

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
