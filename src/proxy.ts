export { auth as proxy } from "@/lib/auth";

export const config = {
  // Protect page routes via the NextAuth session.
  // API routes now self-protect via requireApiAuth() (session OR API key).
  matcher: [
    "/((?!login|api|insights/.*\\.json|_next|favicon\\.ico).*)",
  ],
};
