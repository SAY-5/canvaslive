import { SignJWT, jwtVerify } from "jose";
import { nanoid } from "@canvaslive/shared";

interface TokenClaims {
  sub: string;
  name?: string;
  rooms?: string[]; // if set, user is restricted to these rooms
}

export class Auth {
  private readonly key: Uint8Array;

  constructor(secret: string) {
    this.key = new TextEncoder().encode(secret);
  }

  async issueAnonymous(name?: string): Promise<{ token: string; userId: string }> {
    const userId = "u_" + nanoid(12);
    const token = await new SignJWT({ name: name ?? "anon" })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime("24h")
      .sign(this.key);
    return { token, userId };
  }

  async verify(token: string): Promise<TokenClaims> {
    const { payload } = await jwtVerify(token, this.key);
    const sub = payload.sub;
    if (typeof sub !== "string" || sub.length === 0) {
      throw new Error("token missing subject");
    }
    const claims: TokenClaims = { sub };
    if (typeof payload.name === "string") claims.name = payload.name;
    if (Array.isArray(payload.rooms)) claims.rooms = payload.rooms as string[];
    return claims;
  }

  authorizeRoom(claims: TokenClaims, roomId: string): boolean {
    if (!claims.rooms) return true; // unrestricted
    return claims.rooms.includes(roomId);
  }
}
