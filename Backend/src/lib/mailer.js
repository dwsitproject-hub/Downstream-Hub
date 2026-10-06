/**
 * Password reset / notification emails. Uses SMTP when configured; otherwise logs (dev).
 *
 * SmarterMail and some MTAs reject mail when the client disconnects immediately after DATA 250.
 * We use a pooled transport, configurable timeouts, and a short post-send delay before reuse.
 */
const nodemailer = require('nodemailer');
const { buildBrandedEmail, BRAND } = require('./emailTemplates');

/** @type {import('nodemailer').Transporter | null} */
let pooledTransport = null;

function smtpPassword() {
  return process.env.SMTP_PASS || process.env.SMTP_PASSWORD;
}

function smtpConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && smtpPassword());
}

function envFlag(name, defaultTrue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultTrue;
  return raw === 'true' || raw === '1';
}

function smtpTimeoutMs(name, defaultMs) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultMs;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultMs;
}

function smtpInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : defaultValue;
}

function smtpPostSendDelayMs() {
  return smtpTimeoutMs('SMTP_POST_SEND_DELAY_MS', 2000);
}

function smtpPoolEnabled() {
  return envFlag('SMTP_POOL', true);
}

function smtpDebugEnabled() {
  return envFlag('SMTP_DEBUG', false);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function transportOptions() {
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const secure =
    process.env.SMTP_SECURE === 'true' ||
    process.env.SMTP_SECURE === '1' ||
    port === 465;
  const rejectUnauthorized =
    process.env.SMTP_REJECT_UNAUTHORIZED !== 'false' && process.env.SMTP_REJECT_UNAUTHORIZED !== '0';
  const requireTLS =
    envFlag('SMTP_REQUIRE_TLS', port === 587 && !secure);

  const options = {
    host: process.env.SMTP_HOST,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: smtpPassword(),
    },
    connectionTimeout: smtpTimeoutMs('SMTP_CONNECTION_TIMEOUT_MS', 120000),
    greetingTimeout: smtpTimeoutMs('SMTP_GREETING_TIMEOUT_MS', 120000),
    socketTimeout: smtpTimeoutMs('SMTP_SOCKET_TIMEOUT_MS', 300000),
    tls: {
      rejectUnauthorized,
    },
  };

  if (requireTLS) {
    options.requireTLS = true;
  }

  if (smtpDebugEnabled()) {
    options.logger = true;
    options.debug = true;
  }

  if (smtpPoolEnabled()) {
    options.pool = true;
    options.maxConnections = smtpInt('SMTP_POOL_MAX_CONNECTIONS', 1);
    options.maxMessages = smtpInt('SMTP_POOL_MAX_MESSAGES', 10);
  }

  return options;
}

function createTransport() {
  if (!smtpConfigured()) return null;
  return nodemailer.createTransport(transportOptions());
}

function getTransport() {
  if (!smtpConfigured()) return null;
  if (smtpPoolEnabled()) {
    if (!pooledTransport) {
      pooledTransport = createTransport();
    }
    return pooledTransport;
  }
  return createTransport();
}

/**
 * @param {import('nodemailer').SendMailOptions} mailOptions
 * @returns {Promise<import('nodemailer').SentMessageInfo>}
 */
async function sendViaSmtp(mailOptions) {
  const transport = getTransport();
  if (!transport) {
    throw new Error('SMTP not configured');
  }

  const info = await transport.sendMail(mailOptions);
  const postDelayMs = smtpPostSendDelayMs();
  if (postDelayMs > 0) {
    await delay(postDelayMs);
  }

  if (!smtpPoolEnabled() && typeof transport.close === 'function') {
    transport.close();
  }

  return info;
}

const fromAddress = () =>
  process.env.MAIL_FROM || process.env.EMAIL_FROM || process.env.SMTP_USER || 'noreply@localhost';

/**
 * @param {{ to: string, resetUrl: string }} opts
 */
async function sendPasswordResetEmail({ to, resetUrl }) {
  const subject = 'Reset your Downstream Hub password';
  const { html, text } = buildBrandedEmail({
    preheader: 'Reset your Downstream Hub password',
    heading: 'Reset your password',
    intro:
      'We received a request to reset the password for your account. If this was you, use the button below to choose a new password.',
    note: 'This link expires soon.',
    cta: { label: 'Reset password', url: resetUrl },
    footerNote: 'If you did not request a password reset, you can ignore this email.',
  });

  if (!smtpConfigured()) {
    console.info('[mailer] SMTP not configured; password reset link (dev only):');
    console.info(resetUrl);
    return { skipped: true };
  }
  const info = await sendViaSmtp({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  });
  console.info('[mailer] Password reset email sent via SMTP', info.messageId || '');
  return { skipped: false };
}

/**
 * @param {{ to: string }} opts
 */
async function sendPasswordChangedEmail({ to }) {
  const subject = 'Your Downstream Hub password was changed';
  const { html, text } = buildBrandedEmail({
    preheader: 'Your Downstream Hub password was changed',
    heading: 'Password updated',
    intro: 'Your Downstream Hub password was changed successfully.',
    alertHtml: `<p style="margin:0;padding:16px;background-color:${BRAND.bgLight};border:1px dashed ${BRAND.border};border-radius:8px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.6;color:${BRAND.textCharcoal};">If you did not make this change, contact your administrator immediately.</p>`,
    footerNote: 'This is an automated security notice.',
  });

  if (!smtpConfigured()) {
    console.info('[mailer] SMTP not configured; would send password-changed notice to', to);
    return { skipped: true };
  }
  const info = await sendViaSmtp({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  });
  console.info('[mailer] Password changed email sent via SMTP', info.messageId || '');
  return { skipped: false };
}

/**
 * @param {{ to: string, otp: string, ttlSeconds: number }} opts
 */
async function sendOtpEmail({ to, otp, ttlSeconds }) {
  const mins = Math.max(1, Math.floor(ttlSeconds / 60));
  const subject = 'Your Downstream Hub verification code';
  const { html, text } = buildBrandedEmail({
    preheader: `Your verification code is ${otp}`,
    heading: 'Verification code',
    intro: 'Enter this one-time code to complete verification:',
    code: otp,
    note: `It expires in ${mins} minute(s).`,
    footerNote: 'If you did not attempt to sign in, you can ignore this email.',
  });

  if (!smtpConfigured()) {
    console.info('[mailer] SMTP not configured; MFA OTP (dev only):', otp);
    return { skipped: true };
  }
  const info = await sendViaSmtp({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  });
  console.info('[mailer] OTP email sent via SMTP', info.messageId || '');
  return { skipped: false };
}

/**
 * @param {{ to: string, loginUrl: string, ttlMinutes: number }} opts
 */
async function sendLoginMagicLinkEmail({ to, loginUrl, ttlMinutes }) {
  const mins = Math.max(1, Math.floor(ttlMinutes || 15));
  const subject = 'Your Downstream Hub sign-in link';
  const { html, text } = buildBrandedEmail({
    preheader: 'Complete your Downstream Hub sign-in',
    heading: 'Complete your sign-in',
    intro:
      'You requested to sign in to Downstream Hub. Click the button below on this device to continue.',
    note: `This link expires in ${mins} minute(s).`,
    cta: { label: 'Complete sign-in', url: loginUrl },
    footerNote: 'If you did not attempt to sign in, you can ignore this email.',
  });

  if (!smtpConfigured()) {
    console.info('[mailer] SMTP not configured; login magic link (dev only):');
    console.info(loginUrl);
    return { skipped: true };
  }
  const info = await sendViaSmtp({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  });
  console.info('[mailer] Login magic link email sent via SMTP', info.messageId || '');
  return { skipped: false };
}

/**
 * @param {{ to: string, verifyUrl: string }} opts
 */
async function sendSsoLinkVerificationEmail({ to, verifyUrl }) {
  const subject = 'Confirm SSO account linking in Downstream Hub';
  const { html, text } = buildBrandedEmail({
    preheader: 'Confirm SSO account linking in Downstream Hub',
    heading: 'Confirm account linking',
    intro:
      'To link your SSO identity with your Downstream Hub account, verify your email using the button below.',
    cta: { label: 'Confirm SSO linking', url: verifyUrl },
    footerNote: 'If you did not request this action, ignore this email.',
  });

  if (!smtpConfigured()) {
    console.info('[mailer] SMTP not configured; SSO link verification URL (dev only):');
    console.info(verifyUrl);
    return { skipped: true };
  }
  const info = await sendViaSmtp({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  });
  console.info('[mailer] SSO link verification email sent via SMTP', info.messageId || '');
  return { skipped: false };
}

/** Close pooled transport (tests / graceful shutdown). */
function closeTransport() {
  if (pooledTransport && typeof pooledTransport.close === 'function') {
    pooledTransport.close();
    pooledTransport = null;
  }
}

/**
 * Invitation to a newly created account: complete registration by setting a password.
 * @param {{ to: string, activateUrl: string, ttlHours?: number }} opts
 */
async function sendAccountActivationEmail({ to, activateUrl, ttlHours }) {
  const subject = 'Activate your Downstream Hub account';
  const expiryNote = ttlHours ? `This link expires in ${ttlHours} hour(s).` : 'This link expires soon.';
  const { html, text } = buildBrandedEmail({
    preheader: 'Activate your Downstream Hub account',
    heading: 'Welcome to Downstream Hub',
    intro:
      'An administrator created an account for you. To finish setting up, use the button below to verify your email and choose your password.',
    note: expiryNote,
    cta: { label: 'Complete registration', url: activateUrl },
    footerNote: 'If you were not expecting this invitation, you can ignore this email.',
  });

  if (!smtpConfigured()) {
    console.info('[mailer] SMTP not configured; account activation link (dev only):');
    console.info(activateUrl);
    return { skipped: true };
  }
  const info = await sendViaSmtp({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  });
  console.info('[mailer] Account activation email sent via SMTP', info.messageId || '');
  return { skipped: false };
}

module.exports = {
  sendPasswordResetEmail,
  sendAccountActivationEmail,
  sendPasswordChangedEmail,
  sendOtpEmail,
  sendLoginMagicLinkEmail,
  sendSsoLinkVerificationEmail,
  smtpConfigured,
  closeTransport,
};
