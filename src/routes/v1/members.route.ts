import { PointsTransactionKind, WalletProviderType, WalletSyncStatus } from "@prisma/client";
import { timingSafeEqual } from "node:crypto";

import { Router, type RequestHandler } from "express";
import { z } from "zod";

import {
  MemberNotFoundError,
  MembershipValidationError
} from "../../common/errors/membership.errors";
import { WalletConfigurationError } from "../../common/errors/wallet.errors";
import { asyncHandler } from "../../common/middleware/async-handler";
import { createFixedWindowLimiter } from "../../common/middleware/rate-limit";
import { createRequireEdge } from "../../common/middleware/require-edge";
import {
  createRequireStaffKey,
  isStaffKeyConfigured,
  isStaffRequest
} from "../../common/middleware/staff-key";
import { clientIp } from "../../common/utils/client-ip";
import { config } from "../../config/env";
import { prisma } from "../../infrastructure/database/prisma-client";
import { findClinicBySlug } from "../../modules/clinics/clinic.service";
import { PrismaPassClaimService } from "../../modules/members/pass-claim.service";
import { PointsService } from "../../modules/points/points.service";
import {
  PrismaMemberPointsCache,
  PrismaPointsLedgerRepository
} from "../../modules/points/prisma-points-ledger.repository";
import {
  MEMBER_NAME_MAX,
  MEMBER_NAME_MIN,
  cleanMemberName
} from "../../modules/members/member-name";
import { membershipSignupSchema } from "../../modules/members/membership.schema";
import { signUpMember } from "../../modules/members/membership.service";
import { normalizeSpanishMobile } from "../../modules/members/phone-es";
import { buildWalletRegistry, buildWalletSyncQueue } from "../../wallet/wallet.composition";
import { LoyaltyCard } from "../../wallet/engine/loyalty-card";
import {
  InstallArtifact,
  ProgramTemplate
} from "../../wallet/engine/wallet-pass-provider.interface";
import { deriveRedemptionCode } from "../../wallet/engine/redemption-code";
import { PrismaLoyaltyCardAssembler } from "../../wallet/prisma-loyalty-card.assembler";

export const membersRouter = Router();

const requireStaff = createRequireStaffKey(config.STAFF_API_KEY);
const walletSyncQueue = buildWalletSyncQueue(prisma);

/**
 * Null when no redemption secret is configured, which is the same condition that makes
 * the wallet subsystem unusable. The endpoint answers 503 rather than writing points
 * that nothing could ever render onto a card.
 */
const passClaims = new PrismaPassClaimService(prisma);

const pointsService = walletSyncQueue
  ? new PointsService(
      new PrismaPointsLedgerRepository(prisma),
      new PrismaMemberPointsCache(prisma),
      walletSyncQueue
    )
  : null;

const emptyWalletStatus = {
  google: "not_added",
  apple: "not_added"
} as const;

const walletProviderKey = (provider: WalletProviderType): keyof typeof emptyWalletStatus =>
  provider === WalletProviderType.GOOGLE ? "google" : "apple";

const providerStatus = (status: WalletSyncStatus) =>
  status === WalletSyncStatus.SYNCED
    ? "added"
    : status === WalletSyncStatus.FAILED
      ? "failed"
      : "not_added";

const toMemberSummary = (member: Awaited<ReturnType<typeof findMemberForSummary>>) => ({
  id: member.id,
  name: member.name,
  identity: member.phone ?? member.email ?? member.id,
  email: member.email,
  templateId: member.clinic.template?.id ?? "",
  templateName: member.clinic.template?.programName ?? member.clinic.name,
  points: member.pointsBalance,
  tier: member.tier ?? "Nuevo",
  walletStatus: member.walletObjects.reduce(
    (statuses, walletObject) => ({
      ...statuses,
      [walletProviderKey(walletObject.provider)]: providerStatus(walletObject.status)
    }),
    emptyWalletStatus
  ),
  history: []
});

const staffMemberSchema = z
  .object({
    name: z
      .string("Añade el nombre del miembro")
      .max(200, "El nombre es demasiado largo")
      .transform(cleanMemberName)
      .pipe(
        z
          .string()
          .min(MEMBER_NAME_MIN, "Introduce nombre y apellidos")
          .max(MEMBER_NAME_MAX, "El nombre es demasiado largo")
      ),
    email: z
      .string("Añade el email del miembro")
      .trim()
      .toLowerCase()
      .max(254, "El email es demasiado largo")
      .pipe(z.string().email("Introduce un email válido")),
    phone: z
      .string()
      .trim()
      .max(32, "El número de teléfono es demasiado largo")
      .optional()
      .transform((value, ctx) => {
        if (!value) return null;

        const normalized = normalizeSpanishMobile(value);

        if (normalized === null) {
          ctx.addIssue({ code: "custom", message: "Introduce un móvil español válido" });

          return z.NEVER;
        }

        return normalized;
      })
  })
  .transform(({ name, email, phone }) => ({
    name,
    email,
    phone: phone?.e164 ?? null,
    phoneRaw: phone?.raw ?? null,
    phoneRegionAssumed: phone?.regionAssumed ?? false
  }));

const creditSchema = z.object({
  points: z.coerce.number().int().min(1).max(1_000_000),
  label: z.string().trim().min(1).max(120),
  referralCode: z.string().trim().max(80).optional(),
  /**
   * Required, and minted by the caller. A key generated here would differ on every
   * retry, which does not merely fail to stop double-crediting — it guarantees it.
   */
  idempotencyKey: z.string().min(8, "idempotencyKey is required").max(128)
});

const codeSchema = z.string().trim().min(16).max(128);

const emailUnavailable = () =>
  new WalletConfigurationError("SendGrid is not configured for Wallet pass delivery");

const htmlEscape = (value: string): string =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const sendWalletPassEmail = async ({
  to,
  memberName,
  clinicName,
  addToWalletUrl
}: {
  to: string;
  memberName: string;
  clinicName: string;
  addToWalletUrl: string;
}) => {
  if (!config.SENDGRID_API_KEY || !config.SENDGRID_FROM_EMAIL) {
    throw emailUnavailable();
  }

  const escapedMemberName = htmlEscape(memberName);
  const escapedClinicName = htmlEscape(clinicName);
  const escapedAddToWalletUrl = htmlEscape(addToWalletUrl);

  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.SENDGRID_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: config.SENDGRID_FROM_EMAIL, name: clinicName },
      subject: `Tu pase Wallet de ${clinicName}`,
      content: [
        {
          type: "text/plain",
          value: `Hola ${memberName},\n\nAñade tu pase de fidelización de ${clinicName} a Apple Wallet o Google Wallet desde este enlace:\n${addToWalletUrl}\n`
        },
        {
          type: "text/html",
          value: `<p>Hola ${escapedMemberName},</p><p>Añade tu pase de fidelización de <strong>${escapedClinicName}</strong> a Apple Wallet o Google Wallet desde este enlace:</p><p><a href="${escapedAddToWalletUrl}">Abrir pase Wallet</a></p>`
        }
      ]
    })
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`SendGrid request failed: ${response.status} ${detail}`.trim());
  }
};

const findMemberForSummary = (memberId: string) =>
  prisma.member.findUniqueOrThrow({
    where: { id: memberId },
    include: {
      clinic: { include: { template: true } },
      walletObjects: true
    }
  });

const toProgramTemplate = (card: LoyaltyCard, templateId: string): ProgramTemplate => ({
  templateId,
  clinicName: card.clinic.name,
  template: card.template
});

const frontendUrl = (path: string): string => `${config.FRONTEND_URL.replace(/\/$/, "")}${path}`;

const installUrlFor = (artifact: InstallArtifact, code: string): string | null => {
  if (artifact.kind === "link") return artifact.url;

  return frontendUrl(`/api/wallet/passes/${encodeURIComponent(code)}/apple`);
};

const issueWalletPasses = async (memberId: string) => {
  if (!config.CARD_REDEMPTION_SECRET) {
    throw new WalletConfigurationError(
      "CARD_REDEMPTION_SECRET is required to create secure Wallet pass links"
    );
  }

  const member = await findMemberForSummary(memberId);
  const template = member.clinic.template;

  if (!template) {
    throw new MembershipValidationError(
      "template: la clínica no tiene una plantilla Wallet activa"
    );
  }

  const code = deriveRedemptionCode(member.id, config.CARD_REDEMPTION_SECRET);
  const registry = buildWalletRegistry(prisma);
  const assembler = new PrismaLoyaltyCardAssembler(prisma, config.CARD_REDEMPTION_SECRET);
  const card = await assembler.assemble(member.id);
  const program = toProgramTemplate(card, template.id);
  const passes = {
    google: { available: false, url: null as string | null },
    apple: { available: false, url: null as string | null }
  };

  const enabledProviders = registry.enabled();

  if (enabledProviders.length === 0) {
    throw new WalletConfigurationError("No Wallet provider is configured for pass creation");
  }

  const settledProviders = await Promise.allSettled(
    enabledProviders.map(async (provider) => {
      const key = walletProviderKey(provider.provider);
      const programRef = await provider.provisionProgram(program);
      const issued = await provider.issueCard(card, programRef);

      passes[key] = { available: true, url: installUrlFor(issued.install, code) };

      return key;
    })
  );

  const issuedProviderCount = settledProviders.filter(
    (result): result is PromiseFulfilledResult<keyof typeof passes> => result.status === "fulfilled"
  ).length;

  settledProviders.forEach((result, index) => {
    if (result.status === "rejected") {
      const provider = enabledProviders[index];

      console.warn(
        `[wallet] ${provider.provider} pass issue failed for member ${member.id}:`,
        result.reason instanceof Error ? result.reason.message : result.reason
      );
    }
  });

  if (issuedProviderCount === 0) {
    throw new WalletConfigurationError("No Wallet provider could issue this member pass");
  }

  return {
    addToWalletUrl: frontendUrl(`/wallet/add/${encodeURIComponent(code)}`),
    code,
    passes
  };
};

const resolveMemberByRedemptionCode = async (code: string, clinicId?: string) => {
  if (!config.CARD_REDEMPTION_SECRET) return null;

  const members = await prisma.member.findMany({
    where: { erasedAt: null, ...(clinicId ? { clinicId } : {}) },
    select: { id: true }
  });

  // Constant-time, and deliberately without an early return: `find` with `===` leaks
  // the code character by character through comparison timing, and stopping at the
  // first hit makes the response time depend on where the member sits in the list.
  const wanted = Buffer.from(code);
  let match: string | null = null;

  for (const member of members) {
    const candidate = Buffer.from(deriveRedemptionCode(member.id, config.CARD_REDEMPTION_SECRET!));

    if (candidate.length === wanted.length && timingSafeEqual(candidate, wanted)) {
      match = member.id;
    }
  }

  return match ? findMemberForSummary(match) : null;
};

/**
 * Ten per address per clinic per ten minutes. Spanish carriers use CGNAT, so many
 * genuine sign-ups share one address and a tighter per-IP limit would block a real
 * reception desk. The clinic is part of the key so one clinic's traffic, legitimate or
 * not, cannot exhaust another's allowance.
 */
const signUpLimiter = createFixedWindowLimiter({
  limit: 10,
  windowMs: 10 * 60 * 1000,
  key: (req) => `${clientIp(req)}:${req.params.slug}`
});

/**
 * The limiter guards anonymous traffic, so a request that proves it came from the staff
 * surface skips it. A clinic's reception shares one address, and manual entries there would
 * otherwise exhaust a ceiling sized for abuse — but loosening the limit for everyone to fix
 * that would have protected nobody. This distinguishes the two rather than splitting the
 * difference, and with no key configured nobody qualifies, so the limit still applies.
 */
const rateLimitAnonymous: RequestHandler = (req, res, next) => {
  if (isStaffRequest(req, config.STAFF_API_KEY)) {
    next();

    return;
  }

  signUpLimiter(req, res, next);
};

// Applied per route rather than to the whole router: Railway's health check reaches the
// origin directly, so guarding /health on an edge header would fail every probe.
const requireEdge = createRequireEdge(config.EDGE_SHARED_SECRET);

/**
 * GET /clinics/:slug/members lives in member-directory.route.ts.
 *
 * There were two implementations of it. This router mounts first, so this one won —
 * and its summary hardcoded `history: []`, which meant the member detail page showed
 * no history at all while a ledger-backed implementation sat unreachable behind it.
 * One route, one implementation.
 */

membersRouter.post(
  "/clinics/:slug/members/pass",
  requireStaff,
  asyncHandler(async (req, res) => {
    const clinic = await findClinicBySlug(prisma, req.params.slug);
    const parsed = staffMemberSchema.safeParse(req.body);

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new MembershipValidationError(details);
    }

    const existing = await prisma.member.findFirst({
      where: {
        clinicId: clinic.id,
        erasedAt: null,
        OR: [
          { email: parsed.data.email },
          ...(parsed.data.phone ? [{ phone: parsed.data.phone }] : [])
        ]
      }
    });

    const member = existing
      ? await prisma.member.update({
          where: { id: existing.id },
          data: {
            name: parsed.data.name,
            email: parsed.data.email,
            ...(parsed.data.phone
              ? {
                  phone: parsed.data.phone,
                  phoneRaw: parsed.data.phoneRaw,
                  phoneRegionAssumed: parsed.data.phoneRegionAssumed
                }
              : {}),
            signupCount: { increment: 1 },
            lastSignupAt: new Date()
          }
        })
      : await prisma.member.create({
          data: {
            clinicId: clinic.id,
            name: parsed.data.name,
            email: parsed.data.email,
            phone: parsed.data.phone,
            phoneRaw: parsed.data.phoneRaw,
            phoneRegionAssumed: parsed.data.phoneRegionAssumed,
            memberSince: new Date().getFullYear(),
            consentMarketing: false,
            consentSource: "staff_entry",
            privacyPolicyVersion: clinic.privacyPolicyVersion,
            lastSignupAt: new Date()
          }
        });

    const wallet = await issueWalletPasses(member.id);
    const summary = await findMemberForSummary(member.id);

    res.status(existing ? 200 : 201).json({
      member: toMemberSummary(summary),
      wallet
    });
  })
);

membersRouter.post(
  "/clinics/:slug/members/:memberId/pass/email",
  requireStaff,
  asyncHandler(async (req, res) => {
    const clinic = await findClinicBySlug(prisma, req.params.slug);
    const member = await findMemberForSummary(req.params.memberId);

    if (member.clinicId !== clinic.id || member.erasedAt) {
      throw new MemberNotFoundError(req.params.memberId);
    }

    const wallet = await issueWalletPasses(member.id);

    if (!wallet.addToWalletUrl) {
      throw new WalletConfigurationError("Wallet pass link could not be generated");
    }

    if (!member.email) {
      throw new MembershipValidationError("email: el miembro no tiene email guardado");
    }

    await sendWalletPassEmail({
      to: member.email,
      memberName: member.name,
      clinicName: clinic.name,
      addToWalletUrl: wallet.addToWalletUrl
    });

    res.json({ status: "sent", email: member.email });
  })
);

membersRouter.get(
  "/clinics/:slug/members/lookup",
  requireStaff,
  asyncHandler(async (req, res) => {
    const clinic = await findClinicBySlug(prisma, req.params.slug);
    const parsed = codeSchema.safeParse(typeof req.query.code === "string" ? req.query.code : "");

    if (!parsed.success) {
      throw new MembershipValidationError("code: código Wallet no válido");
    }

    const member = await resolveMemberByRedemptionCode(parsed.data, clinic.id);

    if (!member) {
      res.status(404).json({ code: "MEMBER_NOT_FOUND", message: "Member not found" });
      return;
    }

    res.json(toMemberSummary(member));
  })
);

membersRouter.post(
  "/clinics/:slug/members/:memberId/points",
  requireStaff,
  asyncHandler(async (req, res) => {
    const clinic = await findClinicBySlug(prisma, req.params.slug);
    const parsed = creditSchema.safeParse(req.body);

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new MembershipValidationError(details);
    }

    if (!pointsService) {
      throw new WalletConfigurationError(
        "No redemption secret is configured, so points cannot be recorded."
      );
    }

    const member = await prisma.member.findFirst({
      where: { id: req.params.memberId, clinicId: clinic.id, erasedAt: null },
      select: { id: true }
    });

    if (!member) {
      res.status(404).json({ code: "MEMBER_NOT_FOUND", message: "Member not found" });
      return;
    }

    // Through the ledger, never straight at the cached column. This used to do
    // `pointsBalance: { increment }`, which wrote no PointsTransaction row — so the
    // movement had no audit trail, no idempotency, and never moved the member's
    // lifetime total or tier. Worse, `npm run points:recompute` rebuilds that column
    // FROM the ledger, so running the reconciliation tool would have silently erased
    // every point credited this way.
    await pointsService.credit({
      memberId: member.id,
      clinicId: clinic.id,
      points: parsed.data.points,
      kind: PointsTransactionKind.EARN,
      reason: parsed.data.label,
      sourceRef: parsed.data.referralCode,
      idempotencyKey: parsed.data.idempotencyKey
    });

    res.json(toMemberSummary(await findMemberForSummary(member.id)));
  })
);

membersRouter.get(
  "/wallet/passes/:code",
  asyncHandler(async (req, res) => {
    const parsed = codeSchema.safeParse(req.params.code);

    if (!parsed.success) {
      res.status(404).json({ code: "PASS_NOT_FOUND", message: "Pass not found" });
      return;
    }

    const member = await resolveMemberByRedemptionCode(parsed.data);

    if (!member) {
      res.status(404).json({ code: "PASS_NOT_FOUND", message: "Pass not found" });
      return;
    }

    const wallet = await issueWalletPasses(member.id);

    res.json({
      member: toMemberSummary(member),
      clinic: { name: member.clinic.name },
      wallet
    });
  })
);

membersRouter.get(
  "/wallet/passes/:code/apple.pkpass",
  asyncHandler(async (req, res) => {
    const parsed = codeSchema.safeParse(req.params.code);

    if (!parsed.success || !config.CARD_REDEMPTION_SECRET) {
      res.status(404).json({ code: "PASS_NOT_FOUND", message: "Pass not found" });
      return;
    }

    const member = await resolveMemberByRedemptionCode(parsed.data);

    if (!member || !member.clinic.template) {
      res.status(404).json({ code: "PASS_NOT_FOUND", message: "Pass not found" });
      return;
    }

    const provider = buildWalletRegistry(prisma).get(WalletProviderType.APPLE);

    if (!provider) {
      res.status(404).json({ code: "APPLE_PASS_UNAVAILABLE", message: "Apple Wallet unavailable" });
      return;
    }

    const assembler = new PrismaLoyaltyCardAssembler(prisma, config.CARD_REDEMPTION_SECRET);
    const card = await assembler.assemble(member.id);
    const programRef = await provider.provisionProgram(
      toProgramTemplate(card, member.clinic.template.id)
    );
    const issued = await provider.issueCard(card, programRef);

    if (issued.install.kind !== "file") {
      res.status(404).json({ code: "APPLE_PASS_UNAVAILABLE", message: "Apple Wallet unavailable" });
      return;
    }

    res.setHeader("Content-Type", issued.install.contentType);
    res.setHeader("Content-Disposition", `attachment; filename="${issued.install.fileName}"`);
    res.send(issued.install.buffer);
  })
);

membersRouter.post(
  "/clinics/:slug/members",
  requireEdge,
  rateLimitAnonymous,
  asyncHandler(async (req, res) => {
    // The clinic is resolved before the body is validated: an unknown slug is a 404
    // whatever was submitted, and there is no point reporting field errors for a clinic
    // that does not exist.
    const clinic = await findClinicBySlug(prisma, req.params.slug);

    const parsed = membershipSignupSchema.safeParse(req.body);

    if (!parsed.success) {
      const details = parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ");

      throw new MembershipValidationError(details);
    }

    // Provenance is evidence, so a claim to be staff has to be proved. Unconfigured, the
    // claim is taken at face value — that is the local-development case, and refusing it
    // would break the dashboard on a machine with no key.
    if (
      parsed.data.consentSource === "staff_entry" &&
      isStaffKeyConfigured(config.STAFF_API_KEY) &&
      !isStaffRequest(req, config.STAFF_API_KEY)
    ) {
      throw new MembershipValidationError("consentSource: no autorizado");
    }

    // The default lives here rather than in the schema or the service: it is an API
    // default, so an omitted field means the public form, while the staff surface states
    // itself explicitly.
    const result = await signUpMember(
      prisma,
      clinic,
      parsed.data,
      parsed.data.consentSource ?? "qr_signup"
    );

    /**
     * A claim ONLY when the member was newly created.
     *
     * This is the one place the response is allowed to differ, and the difference is
     * deliberate (VOO-102). Handing the card over here is the whole product: the member
     * scanned a QR with their camera, so they are already in a browser on the phone the
     * card is for, and that is the best moment there will ever be.
     *
     * An existing number gets nothing back. That is what stops someone typing a
     * stranger's number and receiving their name and points — which an immediate pass
     * for everyone would do. What remains is a weaker signal: the shape of the response
     * reveals whether a number is already a member. Accepted knowingly, because the
     * alternative taxes every legitimate member forever to close a targeted case that
     * also requires already knowing the number, and the rate limiter bounds bulk
     * probing. The stored name and balance are never exposed either way.
     *
     * Still never a 201: the status code stays 200 for both.
     */
    const claimToken = result.memberId ? await passClaims.mint(result.memberId) : undefined;

    res.status(200).json({ status: "ok", claimToken });
  })
);
