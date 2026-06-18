import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Railway serves the bare apex `murmel.sh` directly (the apex is A-recorded to
 * Railway's edge, with Railway-issued TLS). We keep `www.murmel.sh` canonical —
 * where auth + CORS are configured — so this permanently redirects any apex
 * request to the www host, preserving path + query.
 */
export function middleware(req: NextRequest) {
  if (req.headers.get("host") === "murmel.sh") {
    const url = req.nextUrl.clone();
    url.protocol = "https:";
    url.host = "www.murmel.sh";
    url.port = "";
    return NextResponse.redirect(url, 308);
  }
  return NextResponse.next();
}

export const config = {
  // All routes except Next internals/static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
