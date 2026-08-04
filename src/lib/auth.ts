import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { bearer, username } from "better-auth/plugins";
import { db } from "./db";

export const auth = betterAuth({
  database: drizzleAdapter(db, { provider: "pg" }),
  emailAndPassword: {
    enabled: true,
  },
  user: {
    additionalFields: {
      vaultPlus: {
        type: "boolean",
        required: false,
        defaultValue: false,
      },
    },
  },
  plugins: [bearer(), username()],
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:3000",
  trustedOrigins: [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:3000",
    "http://localhost:3001",
    "http://localhost:3002",
    "https://vault.parcoil.com",
    "file://",
    "null",
  ],
  advanced: {
    disableCSRFCheck: true,
  },
});
