import nodemailer from "nodemailer";

let cachedTransporter: nodemailer.Transporter | null = null;
let cachedSmtpKey = "";

function readSmtpConfig() {
  const user = (process.env.ALERT_EMAIL_USER ?? "").trim();
  const pass = (process.env.ALERT_EMAIL_PASS ?? "").trim();
  const to = (process.env.ALERT_EMAIL_TO ?? "").trim();
  if (!user || !pass || !to) return null;

  const host = (process.env.ALERT_EMAIL_HOST ?? (user.endsWith("@qq.com") ? "smtp.qq.com" : "")).trim();
  const port = Number(process.env.ALERT_EMAIL_PORT ?? (host === "smtp.qq.com" ? 465 : 465)) || 465;
  const secure = String(process.env.ALERT_EMAIL_SECURE ?? (port === 465 ? "true" : "false")).toLowerCase() === "true";
  const from = (process.env.ALERT_EMAIL_FROM ?? user).trim();

  if (!host) return null;
  return { host, port, secure, user, pass, to, from };
}

function getTransporter(config: NonNullable<ReturnType<typeof readSmtpConfig>>) {
  const key = `${config.host}|${config.port}|${config.secure ? 1 : 0}|${config.user}|${config.pass}`;
  if (cachedTransporter && cachedSmtpKey === key) return cachedTransporter;
  cachedSmtpKey = key;
  cachedTransporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
  return cachedTransporter;
}

async function sendWebhookFallback(subject: string, text: string): Promise<boolean> {
  const url = (process.env.ALERT_EMAIL_WEBHOOK_URL ?? "").trim();
  if (!url || !globalThis.fetch) return false;
  const to = process.env.ALERT_EMAIL_TO ?? "";
  await globalThis.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, subject, text }),
  });
  return true;
}

export async function sendAlertEmail(subject: string, text: string): Promise<boolean> {
  const smtpConfig = readSmtpConfig();
  if (smtpConfig) {
    const transporter = getTransporter(smtpConfig);
    await transporter.sendMail({
      from: smtpConfig.from,
      to: smtpConfig.to,
      subject,
      text,
    });
    return true;
  }
  return sendWebhookFallback(subject, text);
}
