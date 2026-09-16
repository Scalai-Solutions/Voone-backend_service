export const logger = {
  error(message: string, metadata?: Record<string, unknown>) {
    console.error(message, metadata);
  },
  info(message: string, metadata?: Record<string, unknown>) {
    console.info(message, metadata);
  }
};
