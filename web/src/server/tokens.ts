import "server-only";
import { createHash, randomBytes } from "node:crypto";

export function createSecretToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type ServiceDependencies = {
  clock?: () => Date;
  createToken?: () => string;
};

export function serviceNow(dependencies?: Pick<ServiceDependencies, "clock">): Date {
  return dependencies?.clock?.() ?? new Date();
}

export function newToken(dependencies?: Pick<ServiceDependencies, "createToken">): string {
  return dependencies?.createToken?.() ?? createSecretToken();
}
