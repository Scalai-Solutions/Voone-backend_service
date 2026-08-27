export class WalletPassEngine {
  createPass(): never {
    throw new Error("Not implemented");
  }

  updatePass(): never {
    throw new Error("Not implemented");
  }

  deletePass(): never {
    throw new Error("Not implemented");
  }
}

export const walletPassEngine = new WalletPassEngine();
