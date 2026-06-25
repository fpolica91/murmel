import { Resend } from "resend";

const DEFAULT_FROM = "Murmel <noreply@murmel.sh>";

let client: Resend | null = null;

function resend(): Resend {
  if (!client) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      throw new Error("RESEND_API_KEY is required to send email");
    }
    client = new Resend(key);
  }
  return client;
}

function from(): string {
  return process.env.RESEND_FROM ?? DEFAULT_FROM;
}

export async function sendVerificationEmail(args: {
  to: string;
  url: string;
}): Promise<void> {
  const { to, url } = args;
  const { error } = await resend().emails.send({
    from: from(),
    to,
    subject: "Verify your email for Murmel",
    text: verificationText(url),
    html: verificationHtml(url),
  });
  if (error) {
    throw new Error(`Resend failed to send verification email: ${error.message}`);
  }
}

function verificationText(url: string): string {
  return [
    "Welcome to Murmel.",
    "",
    "Confirm your email address to finish setting up your account:",
    url,
    "",
    "If you didn't create a Murmel account, you can ignore this email.",
  ].join("\n");
}

function verificationHtml(url: string): string {
  const safeUrl = escapeHtml(url);
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#0b0b0f;">
    <div style="max-width:480px;margin:0 auto;padding:40px 24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#e7e7ea;">
      <div style="font-size:20px;font-weight:600;letter-spacing:-0.01em;color:#ffffff;margin-bottom:24px;">Murmel</div>
      <div style="font-size:16px;line-height:1.6;color:#c9c9d1;">
        <p style="margin:0 0 16px;">Welcome. Confirm your email address to finish setting up your account.</p>
      </div>
      <a href="${safeUrl}" style="display:inline-block;margin:8px 0 24px;padding:12px 20px;background:#ffffff;color:#0b0b0f;text-decoration:none;border-radius:8px;font-size:15px;font-weight:600;">Verify email</a>
      <div style="font-size:13px;line-height:1.6;color:#85858f;">
        <p style="margin:0 0 8px;">Or paste this link into your browser:</p>
        <p style="margin:0 0 24px;word-break:break-all;"><a href="${safeUrl}" style="color:#8a8aff;">${safeUrl}</a></p>
        <p style="margin:0;">If you didn't create a Murmel account, you can ignore this email.</p>
      </div>
    </div>
  </body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
