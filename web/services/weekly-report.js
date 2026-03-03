import { db } from "../firebase.js";
import sgMail from "@sendgrid/mail";

const API_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || "reports@adzone.app";

// ─── HTML template helpers ───────────────────────────────────

function formatCurrency(cents) {
  return "$" + (cents / 100).toFixed(2);
}

function formatNumber(n) {
  return (n || 0).toLocaleString("en-US");
}

function wrapHtml(content) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
        <!-- Header -->
        <tr><td style="background:#18181b;padding:28px 32px;">
          <table width="100%"><tr>
            <td><span style="font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">AdZone</span></td>
            <td align="right"><span style="font-size:13px;color:#a1a1aa;">Weekly Report</span></td>
          </tr></table>
        </td></tr>
        <!-- Body -->
        <tr><td style="padding:32px;">
          ${content}
        </td></tr>
        <!-- Footer -->
        <tr><td style="padding:20px 32px;border-top:1px solid #e5e5e5;background:#fafafa;">
          <p style="margin:0;font-size:12px;color:#a1a1aa;line-height:1.5;">
            This is your weekly performance digest from AdZone.<br>
            &copy; ${new Date().getFullYear()} AdZone
          </p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function statCard(label, value, color = "#18181b") {
  return `<td style="padding:12px 16px;background:#f9fafb;border-radius:8px;text-align:center;border:1px solid #f0f0f0;">
    <p style="margin:0 0 4px;font-size:11px;color:#71717a;text-transform:uppercase;letter-spacing:0.5px;">${label}</p>
    <p style="margin:0;font-size:22px;font-weight:700;color:${color};">${value}</p>
  </td>`;
}

// ─── Merchant weekly report ──────────────────────────────────

function buildMerchantReport(merchant, stats) {
  const ctr = stats.impressions > 0 ? ((stats.clicks / stats.impressions) * 100).toFixed(2) : "0.00";
  const prevCtr = stats.prevImpressions > 0 ? ((stats.prevClicks / stats.prevImpressions) * 100).toFixed(2) : "0.00";

  const revDelta = stats.prevRevenue > 0
    ? (((stats.revenue - stats.prevRevenue) / stats.prevRevenue) * 100).toFixed(1)
    : "N/A";
  const impDelta = stats.prevImpressions > 0
    ? (((stats.impressions - stats.prevImpressions) / stats.prevImpressions) * 100).toFixed(1)
    : "N/A";

  return wrapHtml(`
    <h1 style="margin:0 0 8px;font-size:24px;color:#18181b;">Weekly Performance Report</h1>
    <p style="margin:0 0 24px;font-size:14px;color:#71717a;">
      ${merchant.shopName || merchant.shopDomain || "Your Store"} &mdash; Week of ${stats.weekStart}
    </p>

    <!-- Stats Grid -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="8" style="margin:0 0 24px;">
      <tr>
        ${statCard("Revenue", formatCurrency(stats.revenue), "#059669")}
        ${statCard("Impressions", formatNumber(stats.impressions))}
      </tr>
      <tr>
        ${statCard("Clicks", formatNumber(stats.clicks))}
        ${statCard("CTR", ctr + "%")}
      </tr>
    </table>

    <!-- Comparison -->
    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin:0 0 24px;">
      <p style="margin:0 0 8px;font-size:13px;font-weight:600;color:#0c4a6e;">Week-over-Week</p>
      <table role="presentation" width="100%" cellspacing="0" cellpadding="4">
        <tr>
          <td style="font-size:13px;color:#3f3f46;">Revenue</td>
          <td align="right" style="font-size:13px;font-weight:600;color:${revDelta !== "N/A" && parseFloat(revDelta) >= 0 ? "#059669" : "#dc2626"};">
            ${revDelta !== "N/A" ? (parseFloat(revDelta) >= 0 ? "+" : "") + revDelta + "%" : "—"}
          </td>
        </tr>
        <tr>
          <td style="font-size:13px;color:#3f3f46;">Impressions</td>
          <td align="right" style="font-size:13px;font-weight:600;color:${impDelta !== "N/A" && parseFloat(impDelta) >= 0 ? "#059669" : "#dc2626"};">
            ${impDelta !== "N/A" ? (parseFloat(impDelta) >= 0 ? "+" : "") + impDelta + "%" : "—"}
          </td>
        </tr>
      </table>
    </div>

    <!-- Top Zones -->
    ${stats.topZones.length > 0 ? `
    <h2 style="margin:0 0 12px;font-size:16px;color:#18181b;">Top Performing Zones</h2>
    <table role="presentation" width="100%" cellpadding="8" cellspacing="0" style="margin:0 0 24px;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
      <tr style="background:#f9fafb;">
        <td style="font-size:12px;font-weight:600;color:#71717a;border-bottom:1px solid #e5e5e5;">Zone</td>
        <td align="right" style="font-size:12px;font-weight:600;color:#71717a;border-bottom:1px solid #e5e5e5;">Impressions</td>
        <td align="right" style="font-size:12px;font-weight:600;color:#71717a;border-bottom:1px solid #e5e5e5;">Revenue</td>
      </tr>
      ${stats.topZones.map(z => `
      <tr>
        <td style="font-size:13px;color:#18181b;border-bottom:1px solid #f0f0f0;">${z.name}</td>
        <td align="right" style="font-size:13px;color:#3f3f46;border-bottom:1px solid #f0f0f0;">${formatNumber(z.impressions)}</td>
        <td align="right" style="font-size:13px;font-weight:600;color:#059669;border-bottom:1px solid #f0f0f0;">${formatCurrency(z.revenue)}</td>
      </tr>`).join("")}
    </table>
    ` : ""}

    <p style="margin:0;font-size:14px;color:#3f3f46;line-height:1.6;">
      Log in to your <a href="#" style="color:#2563eb;text-decoration:none;font-weight:500;">AdZone dashboard</a> for detailed analytics and zone management.
    </p>
  `);
}

// ─── Advertiser weekly report ────────────────────────────────

function buildAdvertiserReport(advertiser, stats) {
  const ctr = stats.impressions > 0 ? ((stats.clicks / stats.impressions) * 100).toFixed(2) : "0.00";

  return wrapHtml(`
    <h1 style="margin:0 0 8px;font-size:24px;color:#18181b;">Weekly Campaign Report</h1>
    <p style="margin:0 0 24px;font-size:14px;color:#71717a;">
      ${advertiser.name || advertiser.companyName || "Your Account"} &mdash; Week of ${stats.weekStart}
    </p>

    <!-- Stats Grid -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="8" style="margin:0 0 24px;">
      <tr>
        ${statCard("Spent", formatCurrency(stats.spent), "#dc2626")}
        ${statCard("Impressions", formatNumber(stats.impressions))}
      </tr>
      <tr>
        ${statCard("Clicks", formatNumber(stats.clicks))}
        ${statCard("CTR", ctr + "%")}
      </tr>
    </table>

    <!-- Balance -->
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin:0 0 24px;">
      <p style="margin:0;font-size:13px;color:#166534;">
        Current wallet balance: <strong>${formatCurrency(advertiser.balance || 0)}</strong>
      </p>
    </div>

    <!-- Top Campaigns -->
    ${stats.topCampaigns.length > 0 ? `
    <h2 style="margin:0 0 12px;font-size:16px;color:#18181b;">Top Campaigns</h2>
    <table role="presentation" width="100%" cellpadding="8" cellspacing="0" style="margin:0 0 24px;border:1px solid #e5e5e5;border-radius:8px;overflow:hidden;">
      <tr style="background:#f9fafb;">
        <td style="font-size:12px;font-weight:600;color:#71717a;border-bottom:1px solid #e5e5e5;">Campaign</td>
        <td align="right" style="font-size:12px;font-weight:600;color:#71717a;border-bottom:1px solid #e5e5e5;">Impressions</td>
        <td align="right" style="font-size:12px;font-weight:600;color:#71717a;border-bottom:1px solid #e5e5e5;">Spent</td>
      </tr>
      ${stats.topCampaigns.map(c => `
      <tr>
        <td style="font-size:13px;color:#18181b;border-bottom:1px solid #f0f0f0;">${c.name}</td>
        <td align="right" style="font-size:13px;color:#3f3f46;border-bottom:1px solid #f0f0f0;">${formatNumber(c.impressions)}</td>
        <td align="right" style="font-size:13px;font-weight:600;color:#dc2626;border-bottom:1px solid #f0f0f0;">${formatCurrency(c.spent)}</td>
      </tr>`).join("")}
    </table>
    ` : ""}

    <p style="margin:0;font-size:14px;color:#3f3f46;line-height:1.6;">
      Visit your <a href="#" style="color:#2563eb;text-decoration:none;font-weight:500;">AdZone dashboard</a> for real-time campaign performance.
    </p>
  `);
}

// ─── Data aggregation ────────────────────────────────────────

function getDateRange(weeksAgo = 0) {
  const now = new Date();
  const end = new Date(now);
  end.setDate(end.getDate() - (7 * weeksAgo));
  const start = new Date(end);
  start.setDate(start.getDate() - 7);
  return {
    start: start.toISOString().split("T")[0],
    end: end.toISOString().split("T")[0],
  };
}

async function getMerchantWeeklyStats(merchantId) {
  const thisWeek = getDateRange(0);
  const lastWeek = getDateRange(1);

  // This week's analytics
  const thisSnap = await db.collection("analytics_daily")
    .where("merchantId", "==", merchantId)
    .where("date", ">=", thisWeek.start)
    .where("date", "<", thisWeek.end)
    .get();

  // Last week's analytics (for comparison)
  const lastSnap = await db.collection("analytics_daily")
    .where("merchantId", "==", merchantId)
    .where("date", ">=", lastWeek.start)
    .where("date", "<", lastWeek.end)
    .get();

  let impressions = 0, clicks = 0, revenue = 0;
  const zoneMap = {};
  for (const doc of thisSnap.docs) {
    const d = doc.data();
    impressions += d.impressions || 0;
    clicks += d.clicks || 0;
    revenue += d.revenue || 0;
    const zoneId = d.zoneId || "unknown";
    if (!zoneMap[zoneId]) zoneMap[zoneId] = { name: d.zoneName || zoneId, impressions: 0, revenue: 0 };
    zoneMap[zoneId].impressions += d.impressions || 0;
    zoneMap[zoneId].revenue += d.revenue || 0;
  }

  let prevImpressions = 0, prevClicks = 0, prevRevenue = 0;
  for (const doc of lastSnap.docs) {
    const d = doc.data();
    prevImpressions += d.impressions || 0;
    prevClicks += d.clicks || 0;
    prevRevenue += d.revenue || 0;
  }

  const topZones = Object.values(zoneMap)
    .sort((a, b) => b.revenue - a.revenue)
    .slice(0, 5);

  return {
    weekStart: thisWeek.start,
    impressions, clicks, revenue,
    prevImpressions, prevClicks, prevRevenue,
    topZones,
  };
}

async function getAdvertiserWeeklyStats(advertiserId) {
  const thisWeek = getDateRange(0);

  const snap = await db.collection("analytics_daily")
    .where("advertiserId", "==", advertiserId)
    .where("date", ">=", thisWeek.start)
    .where("date", "<", thisWeek.end)
    .get();

  let impressions = 0, clicks = 0, spent = 0;
  const campaignMap = {};
  for (const doc of snap.docs) {
    const d = doc.data();
    impressions += d.impressions || 0;
    clicks += d.clicks || 0;
    spent += d.spend || d.revenue || 0;
    const cId = d.campaignId || "unknown";
    if (!campaignMap[cId]) campaignMap[cId] = { name: d.campaignName || cId, impressions: 0, spent: 0 };
    campaignMap[cId].impressions += d.impressions || 0;
    campaignMap[cId].spent += d.spend || d.revenue || 0;
  }

  const topCampaigns = Object.values(campaignMap)
    .sort((a, b) => b.spent - a.spent)
    .slice(0, 5);

  return {
    weekStart: thisWeek.start,
    impressions, clicks, spent,
    topCampaigns,
  };
}

// ─── Main send functions ─────────────────────────────────────

export async function sendWeeklyMerchantReports() {
  if (!API_KEY) {
    console.log("[weekly-report] Skipping merchant reports — no SendGrid API key");
    return;
  }

  console.log("[weekly-report] Starting merchant weekly reports...");
  const merchantsSnap = await db.collection("merchants")
    .where("status", "==", "active")
    .get();

  let sent = 0;
  for (const doc of merchantsSnap.docs) {
    const merchant = { id: doc.id, ...doc.data() };
    if (!merchant.email) continue;

    // Check if merchant opted out of reports
    if (merchant.settings?.weeklyReports === false) continue;

    try {
      const stats = await getMerchantWeeklyStats(doc.id);
      // Skip if zero activity
      if (stats.impressions === 0 && stats.revenue === 0) continue;

      const html = buildMerchantReport(merchant, stats);
      await sgMail.send({
        to: merchant.email,
        from: { email: FROM_EMAIL, name: "AdZone" },
        subject: `AdZone Weekly Report — ${stats.weekStart}`,
        html,
      });
      sent++;
    } catch (err) {
      console.error(`[weekly-report] Failed to send merchant report to ${merchant.email}:`, err.message);
    }
  }

  console.log(`[weekly-report] Sent ${sent} merchant reports`);
}

export async function sendWeeklyAdvertiserReports() {
  if (!API_KEY) {
    console.log("[weekly-report] Skipping advertiser reports — no SendGrid API key");
    return;
  }

  console.log("[weekly-report] Starting advertiser weekly reports...");
  const advertisersSnap = await db.collection("advertisers").get();

  let sent = 0;
  for (const doc of advertisersSnap.docs) {
    const advertiser = { id: doc.id, ...doc.data() };
    if (!advertiser.email) continue;

    // Check opt-out
    if (advertiser.settings?.weeklyReports === false) continue;

    try {
      const stats = await getAdvertiserWeeklyStats(doc.id);
      if (stats.impressions === 0 && stats.spent === 0) continue;

      const html = buildAdvertiserReport(advertiser, stats);
      await sgMail.send({
        to: advertiser.email,
        from: { email: FROM_EMAIL, name: "AdZone" },
        subject: `AdZone Weekly Campaign Report — ${stats.weekStart}`,
        html,
      });
      sent++;
    } catch (err) {
      console.error(`[weekly-report] Failed to send advertiser report to ${advertiser.email}:`, err.message);
    }
  }

  console.log(`[weekly-report] Sent ${sent} advertiser reports`);
}
