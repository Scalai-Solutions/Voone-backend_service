import { config } from "../config/env";
import { prisma } from "../infrastructure/database/prisma-client";
import { createNotificationWorker } from "../infrastructure/queue/bull-notifications.queue";
import { buildNotificationService } from "../modules/notifications/notification.composition";

const main = async (): Promise<void> => {
  if (config.WALLET_SYNC_MODE !== "queue") {
    console.error(
      "WALLET_SYNC_MODE is not 'queue', so there is no notification queue to consume. " +
        "The API is running notification jobs inline."
    );
    process.exit(1);
  }

  if (config.WALLET_WORKER_IN_PROCESS) {
    console.warn(
      "WALLET_WORKER_IN_PROCESS is true, so the API is consuming notification jobs as well. " +
        "Set it to false on the API when running this dedicated worker."
    );
  }

  const worker = createNotificationWorker(config.REDIS_URL, buildNotificationService(prisma));

  console.log("[notifications] worker listening");

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`[notifications] ${signal} received, finishing in-flight jobs`);

    await worker.close();
    await prisma.$disconnect();

    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
};

void main();
