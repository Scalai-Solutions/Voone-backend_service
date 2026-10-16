import type { UserRole } from "@prisma/client";

export const PERMISSIONS = {
  clinicEdit: "clinic:edit",
  membersManage: "members:manage",
  pointsAdjust: "points:adjust",
  scanUse: "scan:use",
  notificationsSend: "notifications:send",
  teamManage: "team:manage"
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export interface RbacActor {
  role: string;
  permissions?: string[];
}

const normalizedRole = (role: string): UserRole | "" => role.trim().toUpperCase() as UserRole | "";

export const roleHasPermission = (role: string, permission: Permission): boolean => {
  const normalized = normalizedRole(role);

  if (normalized === "VOONE_ADMIN" || normalized === "OWNER") return true;
  if (normalized === "MANAGER") return permission !== PERMISSIONS.teamManage;

  return false;
};

export const hasPermission = (actor: RbacActor, permission: Permission): boolean =>
  roleHasPermission(actor.role, permission) || Boolean(actor.permissions?.includes(permission));

export const sanitizePermissions = (permissions: readonly string[] = []): Permission[] => {
  const allowed = new Set<string>(ALL_PERMISSIONS);

  return Array.from(
    new Set(permissions.filter((permission) => allowed.has(permission)))
  ) as Permission[];
};
