import { buildApp } from "./app";
import { isAppleWalletConfigured } from "./config/apple-wallet.config";
import { config } from "./config/env";

const app = buildApp();

// Signing material is a feature precondition, not a boot one: the service runs fine
// without it and only pass generation fails, so this warns rather than exits.
if (!isAppleWalletConfigured()) {
  console.warn("Apple Wallet signing is not configured; pass generation is disabled.");
}

app.listen(config.PORT, () => {
  console.log(`Voone backend listening at http://localhost:${config.PORT}`);
});
