import { createHash, timingSafeEqual } from "node:crypto";

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function timingSafeTokenEqual(
  providedToken: string | null | undefined,
  expectedToken: string,
): boolean {
  const provided = providedToken ?? "";
  const matches = timingSafeEqual(sha256(provided), sha256(expectedToken));
  return providedToken != null && matches;
}

/** Extract Bearer token from an Authorization header value. */
export function getBearerToken(header: string | undefined): string | undefined {
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice(7);
}

/** Extract token from either Bearer header or ?token= query param. */
export function extractToken(authHeader: string | undefined, url: string): string | undefined {
  const bearer = getBearerToken(authHeader);
  if (bearer) {
    return bearer;
  }
  try {
    const u = new URL(url, "http://localhost");
    return u.searchParams.get("token") ?? undefined;
  } catch {
    return undefined;
  }
}
