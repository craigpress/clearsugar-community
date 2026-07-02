// ClearSugar — Role-based access control
// Roles come from the user record in the `auth/users` store.

export type UserRole = "owner" | "parent" | "child" | "viewer";

const VALID_ROLES: readonly UserRole[] = [
  "owner",
  "parent",
  "child",
  "viewer",
];

/**
 * Normalize the role from a user record / session into a known UserRole.
 * Unknown, missing, or malformed roles fail closed to the least-privileged
 * "viewer" role.
 */
export function getUserRole(role: string | null | undefined): UserRole {
  if (typeof role === "string" && (VALID_ROLES as readonly string[]).includes(role)) {
    return role as UserRole;
  }
  return "viewer";
}

/** What each role can access */
export const ROLE_PERMISSIONS: Record<
  UserRole,
  {
    canViewDashboard: boolean;
    canViewTrends: boolean;
    canViewAnalysis: boolean;
    canViewInsights: boolean;
    canViewSettings: boolean;
    canInvite: boolean;
    label: string;
  }
> = {
  owner: {
    canViewDashboard: true,
    canViewTrends: true,
    canViewAnalysis: true,
    canViewInsights: true,
    canViewSettings: true,
    canInvite: true,
    label: "Owner",
  },
  parent: {
    canViewDashboard: true,
    canViewTrends: true,
    canViewAnalysis: true,
    canViewInsights: true,
    canViewSettings: false,
    canInvite: false,
    label: "Parent",
  },
  child: {
    canViewDashboard: true,
    canViewTrends: true,
    canViewAnalysis: false,
    canViewInsights: false,
    canViewSettings: false,
    canInvite: false,
    label: "Patient",
  },
  viewer: {
    canViewDashboard: true,
    canViewTrends: false,
    canViewAnalysis: false,
    canViewInsights: false,
    canViewSettings: false,
    canInvite: false,
    label: "Viewer",
  },
};
