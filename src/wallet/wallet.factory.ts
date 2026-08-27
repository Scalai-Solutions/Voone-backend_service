import { WalletProvider } from "./engine/wallet-provider.interface";

// This will route wallet operations to the correct provider implementation.
export const getWalletProvider = (platform: "apple" | "google"): WalletProvider => {
  void platform;

  throw new Error("Not implemented");
};
