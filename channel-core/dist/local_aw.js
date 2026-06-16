import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
export function createLocalAWDecryptProvider(options) {
    const awCommand = options.awCommand || process.env.AW_BIN || "aw";
    return {
        async mailMessage(messageID) {
            const id = messageID.trim();
            if (!id)
                return null;
            const { stdout } = await execFileAsync(awCommand, ["mail", "show", "--message-id", id, "--json"], { cwd: options.workdir, timeout: 15_000, maxBuffer: 1024 * 1024 });
            const payload = parseJSONOutput(stdout);
            return (payload.messages || []).find((msg) => msg.message_id === id) || null;
        },
        async chatMessage(sessionID, messageID) {
            const session = sessionID.trim();
            const id = messageID.trim();
            if (!session || !id)
                return null;
            const { stdout } = await execFileAsync(awCommand, ["chat", "history", "--session-id", session, "--message-id", id, "--limit", "1", "--json"], { cwd: options.workdir, timeout: 15_000, maxBuffer: 1024 * 1024 });
            const payload = parseJSONOutput(stdout);
            return (payload.messages || []).find((msg) => msg.message_id === id) || null;
        },
    };
}
function parseJSONOutput(stdout) {
    const trimmed = stdout.trim();
    if (!trimmed)
        throw new Error("aw returned empty JSON output");
    const start = trimmed.indexOf("{");
    if (start < 0)
        throw new Error("aw JSON output did not contain an object");
    return JSON.parse(trimmed.slice(start));
}
