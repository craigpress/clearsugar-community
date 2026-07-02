import NextAuth, { type DefaultSession } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { getUserRole, type UserRole } from "@/lib/roles";
import {
  verifyPassword,
  isRateLimited,
  recordFailedAttempt,
  clearFailedAttempts,
} from "@/lib/users-store";

// Type augmentation so `role` is carried through the User, JWT, and Session.
declare module "next-auth" {
  interface User {
    role?: UserRole;
  }
  interface Session {
    user: {
      role?: UserRole;
    } & DefaultSession["user"];
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  session: { strategy: "jwt" },
  providers: [
    Credentials({
      credentials: {
        username: { label: "Username", type: "text" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const username =
          typeof credentials?.username === "string"
            ? credentials.username
            : "";
        const password =
          typeof credentials?.password === "string"
            ? credentials.password
            : "";

        if (!username || !password) return null;

        // Fail closed if too many recent failures for this username.
        if (isRateLimited(username)) return null;

        const user = await verifyPassword(username, password);
        if (!user) {
          recordFailedAttempt(username);
          return null;
        }

        clearFailedAttempts(username);
        return {
          id: user.username,
          name: user.username,
          role: getUserRole(user.role),
        };
      },
    }),
  ],
  callbacks: {
    // Keeps the middleware/proxy redirect-to-/login behaviour: any request
    // without a valid session is denied and bounced to the sign-in page.
    authorized({ auth }) {
      return !!auth?.user;
    },
    async jwt({ token, user }) {
      if (user) {
        token.role = getUserRole((user as { role?: string }).role);
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.role = getUserRole(token.role as string | undefined);
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
});
