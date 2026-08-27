// Contract every wallet provider, such as Apple or Google, must implement.
export interface WalletProvider {
  createPass(data: unknown): Promise<unknown>;
  updatePass(passId: string, data: unknown): Promise<unknown>;
  deletePass(passId: string): Promise<void>;
  registerDevice(deviceId: string, passId: string): Promise<void>;
  unregisterDevice(deviceId: string, passId: string): Promise<void>;
}
