import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

import { config } from "../../config/env";

const SCRYPT_KEY_LENGTH = 64;
const PASSWORD_SETUP_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type DatabaseClient = PrismaClient;

export const generateTemporaryPassword = (): string => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(14);

  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
};

export const hashPassword = (password: string): string => {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, SCRYPT_KEY_LENGTH).toString("hex");

  return `scrypt:${salt}:${hash}`;
};

export const verifyPassword = (password: string, storedHash: string | null): boolean => {
  if (!storedHash) return false;

  const [algorithm, salt, hash] = storedHash.split(":");

  if (algorithm !== "scrypt" || !salt || !hash) return false;

  const expected = Buffer.from(hash, "hex");
  const received = scryptSync(password, salt, expected.length);

  return expected.length === received.length && timingSafeEqual(expected, received);
};

export const passwordSetupUrl = (token: string): string =>
  `${config.FRONTEND_URL.replace(/\/$/, "")}/set-password/${encodeURIComponent(token)}`;

export const createPasswordSetupLink = async (
  db: DatabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<{ token: string; url: string; expiresAt: Date }> => {
  const expiresAt = new Date(now.getTime() + PASSWORD_SETUP_TOKEN_TTL_MS);

  await db.passwordSetupToken.updateMany({
    where: { userId, usedAt: null, expiresAt: { gt: now } },
    data: { usedAt: now }
  });

  const setupToken = await db.passwordSetupToken.create({
    data: { userId, expiresAt }
  });

  return { token: setupToken.id, url: passwordSetupUrl(setupToken.id), expiresAt };
};

export const sendPasswordSetupEmail = async ({
  to,
  clinicName,
  setupUrl
}: {
  to: string;
  clinicName: string;
  setupUrl: string;
}): Promise<void> => {
  if (!config.SENDGRID_API_KEY || !config.SENDGRID_FROM_EMAIL) {
    throw new Error("SendGrid is not configured");
  }

  const loginUrl = `${config.FRONTEND_URL.replace(/\/$/, "")}/login`;
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.SENDGRID_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: config.SENDGRID_FROM_EMAIL, name: "Voone" },
      subject: `Your Voone access for ${clinicName}`,
      content: [
        {
          type: "text/plain",
          value: [
            `Your Voone account for ${clinicName} is ready.`,
            "",
            `Set your password: ${setupUrl}`,
            `Login after setup: ${loginUrl}`,
            `Email: ${to}`,
            "",
            "This link can be used once."
          ].join("\n")
        },
        {
          type: "text/html",
          value: `<p>Your Voone account for <strong>${clinicName}</strong> is ready.</p><p><a href="${setupUrl}">Set your password</a></p><p><strong>Email:</strong> ${to}</p><p>This link can be used once. After setup, sign in at <a href="${loginUrl}">Voone</a>.</p>`
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`SendGrid request failed: ${response.status} ${detail}`.trim());
  }
};
