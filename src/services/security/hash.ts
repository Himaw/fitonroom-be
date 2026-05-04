import { createHmac } from "node:crypto";

export function hashInstallId(installId: string, secret: string): string {
  return createHmac("sha256", secret).update(installId).digest("hex");
}
