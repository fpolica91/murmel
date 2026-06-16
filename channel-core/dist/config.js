import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import yaml from "js-yaml";
import { loadTeamCertificate, encodeTeamCertificateHeader } from "./identity/certificate.js";
import { computeDIDKey } from "./identity/did.js";
import { loadSigningKey } from "./identity/keys.js";
ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
export async function resolveConfig(workdir) {
    const workspacePath = join(workdir, ".aw", "workspace.yaml");
    const teamsPath = join(workdir, ".aw", "teams.yaml");
    const identityPath = join(workdir, ".aw", "identity.yaml");
    const signingKeyPath = join(workdir, ".aw", "signing.key");
    const workspace = await readYAML(workspacePath);
    if (!workspace) {
        throw new Error("current directory is not initialized for aw; run `aw init` or `aw run` first");
    }
    const baseURL = (workspace.aweb_url || "").trim();
    const legacyTeamAddress = (workspace.team_address || "").trim();
    if (legacyTeamAddress && !Array.isArray(workspace.memberships)) {
        throw new Error("This workspace is on the legacy single-team shape (.aw/workspace.yaml has team_address but no memberships). Run aw workspace migrate-multi-team to convert, then retry.");
    }
    const teamState = await readYAML(teamsPath);
    if (!teamState) {
        throw new Error("worktree team state is missing .aw/teams.yaml; run `aw init` or `aw id team add` first");
    }
    const activeTeam = (teamState.active_team || "").trim();
    const teamMembership = (teamState.memberships || []).find((item) => (item.team_id || "").trim() === activeTeam);
    const workspaceMembership = (workspace.memberships || []).find((item) => (item.team_id || "").trim() === activeTeam);
    const teamID = activeTeam;
    const alias = ((teamMembership?.alias || "").trim());
    const certPath = ((teamMembership?.cert_path || "").trim());
    if (!baseURL || !teamID || !teamMembership || !workspaceMembership) {
        throw new Error("worktree workspace binding is missing aweb_url or active_team");
    }
    const signingKey = await loadSigningKey(signingKeyPath);
    const identity = await readYAML(identityPath);
    const did = computeDIDKey(ed.getPublicKey(signingKey));
    if ((identity?.did || "").trim() && did !== identity?.did?.trim()) {
        throw new Error("identity.yaml did does not match .aw/signing.key");
    }
    const registryURL = (identity?.registry_url || "").trim();
    // Detect token-only vs cert workspace. A cert-less binding (no cert_path and
    // no matching `.aw/team-certs/` entry) authenticates with a Better Auth
    // bearer JWT; the legacy cert binding keeps the DIDKey/team-certificate path.
    const certificate = await tryLoadTeamCertificate(workdir, teamID, certPath);
    if (!certificate) {
        // Token mode: source the bearer from AW_TOKEN / ~/.aw/token (matches the
        // Go CLI's bearer precedence). If no token is available either, fall back
        // to the historical "missing team-certs" error so legacy workspaces still
        // get a clear, actionable message.
        const bearerToken = await resolveBearerToken();
        if (!bearerToken) {
            throw new Error(`No team certificate found for active team ${teamID} and no bearer token available. ` +
                "For a token-only workspace, run `aw login` (or set AW_TOKEN) so the channel can authenticate.");
        }
        return {
            baseURL,
            did,
            stableID: (identity?.stable_id || "").trim(),
            address: (identity?.address || "").trim(),
            alias,
            teamID,
            registryURL,
            signingKey,
            teamCertificateHeader: "",
            authMode: "token",
            bearerToken,
        };
    }
    // Cert mode (legacy): validate the certificate against the active binding.
    if (!alias || !certPath) {
        throw new Error("worktree workspace binding is missing the active membership alias");
    }
    const identityStableID = (identity?.stable_id || "").trim();
    const certificateStableID = (certificate.member_did_aw || "").trim();
    const stableID = certificateStableID || identityStableID;
    const address = ((certificate.member_address || "").trim()) || ((identity?.address || "").trim());
    if ((certificate.member_did_key || "").trim() !== did) {
        throw new Error("team certificate member_did_key does not match .aw/signing.key");
    }
    if ((certificate.team_id || "").trim() !== teamID) {
        throw new Error(`team certificate does not match active team ${teamID}`);
    }
    if ((certificate.alias || "").trim() !== alias) {
        throw new Error("active membership alias does not match the team certificate");
    }
    return {
        baseURL,
        did,
        stableID,
        address,
        alias,
        teamID,
        registryURL,
        signingKey,
        teamCertificateHeader: encodeTeamCertificateHeader(certificate),
        authMode: "cert",
    };
}
/**
 * Resolve a bearer JWT for token-only workspaces, mirroring the Go CLI's
 * precedence: the AW_TOKEN environment variable wins, then the cached token at
 * ~/.aw/token (the `access_token` field of the JSON written by `aw login`).
 * Returns "" when no token is available.
 */
export async function resolveBearerToken() {
    const envToken = (process.env.AW_TOKEN || "").trim();
    if (envToken) {
        return envToken;
    }
    return readCachedToken();
}
async function readCachedToken() {
    const tokenPath = join(homedir(), ".aw", "token");
    let raw;
    try {
        raw = await readFile(tokenPath, "utf-8");
    }
    catch {
        return "";
    }
    try {
        const parsed = JSON.parse(raw);
        return (parsed.access_token || "").trim();
    }
    catch {
        // A bare-token file (not JSON) is tolerated for forward-compat.
        return raw.trim();
    }
}
/**
 * Load the team certificate for the active binding, returning null when none is
 * on disk (token-only workspace) so the caller can branch on auth mode. Any
 * other read/parse failure propagates.
 */
async function tryLoadTeamCertificate(workdir, activeTeam, certPath) {
    if (certPath) {
        try {
            return await loadTeamCertificate(join(workdir, ".aw", certPath));
        }
        catch (error) {
            if (error.code !== "ENOENT") {
                throw error;
            }
            // configured cert_path missing on disk — fall through to dir scan
        }
    }
    return tryLoadActiveTeamCertificate(workdir, activeTeam);
}
async function tryLoadActiveTeamCertificate(workdir, activeTeam) {
    const certsDir = join(workdir, ".aw", "team-certs");
    let files;
    try {
        files = await readdir(certsDir);
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return null;
        }
        throw new Error(`Failed to read team certificates from ${certsDir}: ${String(error)}`);
    }
    for (const file of files) {
        if (!file.endsWith(".pem"))
            continue;
        const cert = await loadTeamCertificate(join(certsDir, file));
        if ((cert.team_id || "").trim() === activeTeam) {
            return cert;
        }
    }
    return null;
}
async function readYAML(path) {
    try {
        const content = await readFile(path, "utf-8");
        return yaml.load(content) || null;
    }
    catch {
        return null;
    }
}
