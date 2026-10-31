import type { Prisma, PrismaClient } from "@prisma/client";

import { hasPermission, PERMISSIONS } from "../auth/rbac";
import { NotificationForbiddenError, NotificationNotFoundError } from "./notification.errors";
import type { NotificationActor, NotificationService } from "./notification.service";
import type { AudienceCreateInput, NotificationSegmentInput } from "./notifications.schema";

export interface ClinicAudience {
  id: string;
  name: string;
  criteria: NotificationSegmentInput;
  /** How many members the criteria match today — what the Audiencias table shows. */
  memberCount: number;
  updatedAt: string;
}

/**
 * A centre's saved audiences (the Audiencias tab): named segment criteria, stored on the
 * clinic so they survive a browser and the whole team sees the same list.
 *
 * The count goes through the SAME resolveSegment a send uses, so what the table claims is
 * what a message would reach. Audiences are counted one at a time rather than in a fan-out —
 * the same discipline the pooler's session limit taught the rest of the app.
 */
export class AudienceService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: Pick<NotificationService, "resolveSegment">
  ) {}

  async list(actor: NotificationActor, clinicId: string): Promise<ClinicAudience[]> {
    this.assertReader(actor, clinicId);

    const audiences: ClinicAudience[] = [];

    for (const row of await this.prisma.clinicAudience.findMany({
      where: { clinicId },
      orderBy: { updatedAt: "desc" }
    })) {
      audiences.push(await this.withCount(clinicId, row));
    }

    return audiences;
  }

  async create(
    actor: NotificationActor,
    clinicId: string,
    input: AudienceCreateInput
  ): Promise<ClinicAudience> {
    this.assertReader(actor, clinicId);

    const row = await this.prisma.clinicAudience.create({
      data: {
        clinicId,
        name: input.name,
        criteria: input.criteria as Prisma.InputJsonValue
      }
    });

    return this.withCount(clinicId, row);
  }

  async remove(
    actor: NotificationActor,
    clinicId: string,
    audienceId: string
  ): Promise<{ status: "deleted" }> {
    this.assertReader(actor, clinicId);

    // deleteMany scoped to the clinic: another clinic's audience id is a no-op here, not a
    // way to delete someone else's segment.
    const removed = await this.prisma.clinicAudience.deleteMany({
      where: { id: audienceId, clinicId }
    });

    if (removed.count === 0) {
      throw new NotificationNotFoundError("Audience not found");
    }

    return { status: "deleted" };
  }

  private async withCount(
    clinicId: string,
    row: { id: string; name: string; criteria: Prisma.JsonValue; updatedAt: Date }
  ): Promise<ClinicAudience> {
    const criteria = row.criteria as NotificationSegmentInput;
    const members = await this.notifications.resolveSegment(clinicId, criteria);

    return {
      id: row.id,
      name: row.name,
      criteria,
      memberCount: members.length,
      updatedAt: row.updatedAt.toISOString()
    };
  }

  /** The same reader check the notification routes use: a clinic's own staff or a Voone admin. */
  private assertReader(actor: NotificationActor, clinicId: string): void {
    if (actor.role.toUpperCase() === "VOONE_ADMIN") return;

    if (actor.clinicId !== clinicId) throw new NotificationForbiddenError();

    if (!hasPermission(actor, PERMISSIONS.notificationsSend)) {
      throw new NotificationForbiddenError("Notifications permission is required");
    }
  }
}
