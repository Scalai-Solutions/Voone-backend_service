import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { config } from "../../config/env";

const SCRYPT_KEY_LENGTH = 64;

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

export const sendOnboardingCredentialsEmail = async ({
  to,
  clinicName,
  password
}: {
  to: string;
  clinicName: string;
  password: string;
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
            `Login: ${loginUrl}`,
            `Email: ${to}`,
            `Temporary password: ${password}`,
            "",
            "Please sign in and change this password after your first access."
          ].join("\n")
        },
        {
          type: "text/html",
          value: `<p>Your Voone account for <strong>${clinicName}</strong> is ready.</p><p><a href="${loginUrl}">Open Voone</a></p><p><strong>Email:</strong> ${to}<br/><strong>Temporary password:</strong> ${password}</p><p>Please sign in and change this password after your first access.</p>`
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`SendGrid request failed: ${response.status} ${detail}`.trim());
  }
};