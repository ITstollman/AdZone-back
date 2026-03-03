import { db } from "../firebase.js";
import { stringify } from "csv-stringify/sync";

// Aggregate daily analytics from raw impressions, clicks, and conversions
export async function aggregateDailyAnalytics() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = yesterday.toISOString().split("T")[0]; // YYYY-MM-DD

  console.log(`Aggregating analytics for ${dateStr}...`);

  // Get all impressions for yesterday
  const startOfDay = new Date(dateStr + "T00:00:00Z");
  const endOfDay = new Date(dateStr + "T23:59:59Z");

  const impressionSnap = await db.collection("impressions")
    .where("timestamp", ">=", startOfDay)
    .where("timestamp", "<=", endOfDay)
    .get();

  const clickSnap = await db.collection("clicks")
    .where("timestamp", ">=", startOfDay)
    .where("timestamp", "<=", endOfDay)
    .get();

  const conversionSnap = await db.collection("conversions")
    .where("timestamp", ">=", startOfDay)
    .where("timestamp", "<=", endOfDay)
    .get();

  // Build breakdowns: by merchant, advertiser, campaign, creative, zone
  const breakdowns = {};

  function getKey(merchantId, advertiserId, campaignId, creativeId, zoneId) {
    return `${merchantId}|${advertiserId}|${campaignId}|${creativeId}|${zoneId}`;
  }

  impressionSnap.docs.forEach(d => {
    const imp = d.data();
    const key = getKey(imp.merchantId, imp.advertiserId, imp.campaignId, imp.creativeId, imp.zoneId);
    if (!breakdowns[key]) {
      breakdowns[key] = {
        merchantId: imp.merchantId || "",
        advertiserId: imp.advertiserId || "",
        campaignId: imp.campaignId || "",
        creativeId: imp.creativeId || "",
        zoneId: imp.zoneId || "",
        impressions: 0,
        clicks: 0,
        spend: 0,
        revenue: 0,
        conversions: 0,
        conversionValue: 0,
      };
    }
    breakdowns[key].impressions += 1;
    breakdowns[key].spend += imp.chargedAmount || imp.cost || 0;
    // Revenue = spend * (1 - platformFee). Platform keeps fee, merchant gets rest.
    const platformFee = parseInt(process.env.PLATFORM_FEE_PERCENT || "20") / 100;
    breakdowns[key].revenue += (imp.chargedAmount || imp.cost || 0) * (1 - platformFee);
  });

  clickSnap.docs.forEach(d => {
    const click = d.data();
    const key = getKey(click.merchantId, click.advertiserId, click.campaignId, click.creativeId, click.zoneId);
    if (breakdowns[key]) {
      breakdowns[key].clicks += 1;
    }
  });

  // Build campaign -> merchantId cache for conversions (conversions lack merchantId/zoneId)
  const campaignIds = [...new Set(conversionSnap.docs.map(d => d.data().campaignId).filter(Boolean))];
  const campaignMerchantMap = {};
  for (const cid of campaignIds) {
    const campDoc = await db.collection("campaigns").doc(cid).get();
    if (campDoc.exists) {
      campaignMerchantMap[cid] = campDoc.data().merchantId || "";
    }
  }

  conversionSnap.docs.forEach(d => {
    const conv = d.data();
    const merchantId = campaignMerchantMap[conv.campaignId] || "";
    const key = getKey(merchantId, conv.advertiserId || "", conv.campaignId || "", "", "");

    if (!breakdowns[key]) {
      breakdowns[key] = {
        merchantId,
        advertiserId: conv.advertiserId || "",
        campaignId: conv.campaignId || "",
        creativeId: "",
        zoneId: "",
        impressions: 0,
        clicks: 0,
        spend: 0,
        revenue: 0,
        conversions: 0,
        conversionValue: 0,
      };
    }
    breakdowns[key].conversions += 1;
    breakdowns[key].conversionValue += conv.value || 0;
  });

  // Write to analytics_daily collection
  const batch = db.batch();
  for (const [key, data] of Object.entries(breakdowns)) {
    const docId = `${dateStr}_${key.replace(/\|/g, "_")}`;
    const ref = db.collection("analytics_daily").doc(docId);
    batch.set(ref, {
      ...data,
      date: dateStr,
      ctr: data.impressions > 0 ? data.clicks / data.impressions : 0,
      conversionRate: data.clicks > 0 ? data.conversions / data.clicks : 0,
      createdAt: new Date(),
    }, { merge: true });
  }

  await batch.commit();
  console.log(`Aggregated ${Object.keys(breakdowns).length} analytics records for ${dateStr}`);
}

// Export analytics as CSV
export function exportAnalyticsCsv(data, columns) {
  const defaultColumns = [
    { key: "date", header: "Date" },
    { key: "impressions", header: "Impressions" },
    { key: "clicks", header: "Clicks" },
    { key: "ctr", header: "CTR" },
    { key: "spend", header: "Spend (cents)" },
    { key: "revenue", header: "Revenue (cents)" },
    { key: "conversions", header: "Conversions" },
    { key: "conversionValue", header: "Conversion Value (cents)" },
  ];

  const cols = columns || defaultColumns;
  return stringify(data, {
    header: true,
    columns: cols,
  });
}
