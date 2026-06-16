/**
 * How the resolved workspace authenticates to aweb.
 * - `cert`: legacy team-certificate / DIDKey signing (`.aw/team-certs/`).
 * - `token`: cert-less, Better Auth bearer JWT + `X-AWEB-Team-Id` (the shape
 *   `aw init` writes after the token-only pivot).
 */
export type AuthMode = "cert" | "token";
export interface AgentConfig {
    baseURL: string;
    did: string;
    stableID: string;
    address: string;
    alias: string;
    teamID: string;
    registryURL: string;
    signingKey: Uint8Array;
    /** Empty in token mode (no team certificate on disk). */
    teamCertificateHeader: string;
    /** Which auth scheme the channel uses to talk to aweb. */
    authMode: AuthMode;
    /** Bearer JWT, present only in token mode. */
    bearerToken?: string;
}
export declare function resolveConfig(workdir: string): Promise<AgentConfig>;
/**
 * Resolve a bearer JWT for token-only workspaces, mirroring the Go CLI's
 * precedence: the AW_TOKEN environment variable wins, then the cached token at
 * ~/.aw/token (the `access_token` field of the JSON written by `aw login`).
 * Returns "" when no token is available.
 */
export declare function resolveBearerToken(): Promise<string>;
