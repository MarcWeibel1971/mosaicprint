import { initTRPC, TRPCError } from "@trpc/server";
import type { Context } from "./context.js";

const t = initTRPC.context<Context>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * adminProcedure – only callable by the admin user.
 * Admin is identified by ADMIN_EMAIL env var (falls back to "marc.weibel@weibel-mueller.ch").
 * Requires a valid Bearer JWT token in the Authorization header.
 */
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL ?? "marc.weibel@weibel-mueller.ch").toLowerCase().trim();

export const adminProcedure = t.procedure.use(({ ctx, next }) => {
  const user = ctx.user;
  if (!user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: "Nicht eingeloggt",
    });
  }
  if (user.email.toLowerCase().trim() !== ADMIN_EMAIL) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "Kein Admin-Zugriff",
    });
  }
  return next({ ctx: { ...ctx, user } });
});
