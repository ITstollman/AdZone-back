import sgMail from "@sendgrid/mail";

const API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "notifications@adzone.app";

if (API_KEY) {
  sgMail.setApiKey(API_KEY);
  console.log("[email:init] SendGrid API key set — fromEmail=%s", FROM_EMAIL);
} else {
  console.warn("[email:init] SENDGRID_API_KEY not set — email notifications will be skipped");
  console.warn("SENDGRID_API_KEY not set — email notifications will be skipped");
}

// ---------------------------------------------------------------------------
// Base HTML wrapper
// ---------------------------------------------------------------------------
function wrapHtml(content) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden;">
        <!-- Header -->
        <tr><td style="background:#18181b;padding:24px 32px;">
          <span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">AdZone</span>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          ${content}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:16px 32px;border-top:1px solid #e5e5e5;">
          <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
            You're receiving this because you have an AdZone account.<br>
            &copy; ${new Date().getFullYear()} AdZone
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Template registry
// ---------------------------------------------------------------------------
const templates = {
  welcome: (vars) => ({
    subject: "Welcome to AdZone!",
    html: wrapHtml(`
      <h1 style="margin:0 0 16px;font-size:22px;color:#18181b;">Welcome, ${vars.name || "there"}!</h1>
      <p style="margin:0 0 16px;font-size:15px;color:#3f3f46;line-height:1.6;">
        Your advertiser account is ready. You can now create campaigns, upload creatives, and start reaching shoppers.
      </p>
      <p style="margin:0;font-size:15px;color:#3f3f46;line-height:1.6;">
        Get started by depositing funds into your wallet, then create your first campaign.
      </p>
    `),
  }),

  creative_approved: (vars) => ({
    subject: `Creative "${vars.creativeName || "Untitled"}" has been approved`,
    html: wrapHtml(`
      <h1 style="margin:0 0 16px;font-size:22px;color:#18181b;">Creative Approved</h1>
      <p style="margin:0 0 16px;font-size:15px;color:#3f3f46;line-height:1.6;">
        Your creative <strong>${vars.creativeName || "Untitled"}</strong> has been approved and is now eligible to serve in ad auctions.
      </p>
      <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px 16px;margin:0 0 16px;">
        <p style="margin:0;font-size:14px;color:#166534;">Status: Approved</p>
      </div>
    `),
  }),

  creative_rejected: (vars) => ({
    subject: `Creative "${vars.creativeName || "Untitled"}" needs changes`,
    html: wrapHtml(`
      <h1 style="margin:0 0 16px;font-size:22px;color:#18181b;">Creative Rejected</h1>
      <p style="margin:0 0 16px;font-size:15px;color:#3f3f46;line-height:1.6;">
        Your creative <strong>${vars.creativeName || "Untitled"}</strong> was not approved. Please review the feedback and resubmit.
      </p>
      <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:6px;padding:12px 16px;margin:0 0 16px;">
        <p style="margin:0 0 4px;font-size:13px;font-weight:600;color:#991b1b;">Feedback:</p>
        <p style="margin:0;font-size:14px;color:#7f1d1d;">${vars.feedback || "No additional feedback provided."}</p>
      </div>
    `),
  }),

  payment_received: (vars) => {
    const dollars = ((vars.amount || 0) / 100).toFixed(2);
    const balanceDollars = ((vars.balance || 0) / 100).toFixed(2);
    return {
      subject: `Payment of $${dollars} received`,
      html: wrapHtml(`
        <h1 style="margin:0 0 16px;font-size:22px;color:#18181b;">Payment Received</h1>
        <p style="margin:0 0 16px;font-size:15px;color:#3f3f46;line-height:1.6;">
          We've received your deposit of <strong>$${dollars}</strong>. Your updated wallet balance is <strong>$${balanceDollars}</strong>.
        </p>
        <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:12px 16px;">
          <p style="margin:0;font-size:14px;color:#166534;">New balance: $${balanceDollars}</p>
        </div>
      `),
    };
  },

  low_balance: (vars) => {
    const balanceDollars = ((vars.balance || 0) / 100).toFixed(2);
    return {
      subject: "Your AdZone balance is running low",
      html: wrapHtml(`
        <h1 style="margin:0 0 16px;font-size:22px;color:#18181b;">Low Balance Warning</h1>
        <p style="margin:0 0 16px;font-size:15px;color:#3f3f46;line-height:1.6;">
          Your wallet balance is <strong>$${balanceDollars}</strong>. Your campaigns may stop serving if the balance reaches zero.
        </p>
        <p style="margin:0;font-size:15px;color:#3f3f46;line-height:1.6;">
          Deposit more funds to keep your campaigns running without interruption.
        </p>
      `),
    };
  },

  budget_exhausted: (vars) => ({
    subject: "Insufficient funds — campaigns paused",
    html: wrapHtml(`
      <h1 style="margin:0 0 16px;font-size:22px;color:#18181b;">Budget Exhausted</h1>
      <p style="margin:0 0 16px;font-size:15px;color:#3f3f46;line-height:1.6;">
        Your wallet balance has reached zero. Active campaigns are no longer serving ads.
      </p>
      <p style="margin:0;font-size:15px;color:#3f3f46;line-height:1.6;">
        Deposit funds to resume ad delivery.
      </p>
    `),
  }),
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a templated email.
 *
 * @param {string} to - Recipient email address
 * @param {string} templateKey - Key from the templates registry
 * @param {Object} variables - Data passed to the template function
 * @returns {Promise<boolean>} true if sent, false if skipped
 */
export async function sendTemplatedEmail(to, templateKey, variables = {}) {
  const _start = Date.now();
  console.log("[email:sendTemplatedEmail] >>> ENTRY — to=%s template=%s variableKeys=%s", to || "(none)", templateKey, Object.keys(variables).join(",") || "(none)");

  if (!API_KEY) {
    console.log("[email:sendTemplatedEmail] <<< EXIT SKIPPED — no SendGrid API key configured (%dms)", Date.now() - _start);
    return false;
  }
  if (!to) {
    console.log("[email:sendTemplatedEmail] <<< EXIT SKIPPED — no recipient email provided (%dms)", Date.now() - _start);
    return false;
  }

  const templateFn = templates[templateKey];
  if (!templateFn) {
    console.warn("[email:sendTemplatedEmail] Template NOT FOUND — templateKey=%s availableTemplates=%s", templateKey, Object.keys(templates).join(","));
    console.warn(`Email template "${templateKey}" not found, skipping`);
    console.log("[email:sendTemplatedEmail] <<< EXIT SKIPPED — template not found (%dms)", Date.now() - _start);
    return false;
  }

  const { subject, html } = templateFn(variables);
  console.log("[email:sendTemplatedEmail] Template rendered — subject=%s htmlLength=%d", subject, html.length);

  console.log("[email:sendTemplatedEmail] Sending via SendGrid — to=%s from=%s subject=%s", to, FROM_EMAIL, subject);
  await sgMail.send({
    to,
    from: { email: FROM_EMAIL, name: "AdZone" },
    subject,
    html,
  });

  console.log("[email:sendTemplatedEmail] <<< EXIT SUCCESS — email sent to=%s template=%s (%dms)", to, templateKey, Date.now() - _start);
  return true;
}
