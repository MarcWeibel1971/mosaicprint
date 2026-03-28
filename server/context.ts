import type { CreateExpressContextOptions } from "@trpc/server/adapters/express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "mosaicprint-dev-secret-change-in-production";

export interface ContextUser {
  id: number;
  email: string;
  display_name: string | null;
}

export function createContext({ req, res }: CreateExpressContextOptions) {
  // Extract user from Bearer token (if present)
  let user: ContextUser | null = null;
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    try {
      const payload = jwt.verify(header.slice(7), JWT_SECRET) as any;
      user = { id: payload.id, email: payload.email, display_name: payload.display_name ?? null };
    } catch { /* invalid token – user stays null */ }
  }
  return { req, res, user };
}

export type Context = ReturnType<typeof createContext>;
