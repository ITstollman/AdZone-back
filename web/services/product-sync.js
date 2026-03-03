import { db } from "../firebase.js";
import shopify from "../shopify.js";

export async function fetchMerchantProducts(
  merchantId,
  { page = 1, limit = 20, collection, search } = {}
) {
  const _start = Date.now();
  console.log("[product-sync:fetchMerchantProducts] >>> ENTRY — merchantId=%s page=%d limit=%d collection=%s search=%s", merchantId, page, limit, collection || "(none)", search || "(none)");

  // Get merchant doc to get shopifyShopId and accessToken
  console.log("[product-sync:fetchMerchantProducts] Fetching merchant document from Firestore — merchantId=%s", merchantId);
  const merchantDoc = await db.collection("merchants").doc(merchantId).get();
  if (!merchantDoc.exists) {
    console.log("[product-sync:fetchMerchantProducts] <<< EXIT FAILED — merchant NOT FOUND — merchantId=%s (%dms)", merchantId, Date.now() - _start);
    throw new Error("Merchant not found");
  }
  const merchant = merchantDoc.data();
  console.log("[product-sync:fetchMerchantProducts] Merchant found — shopDomain=%s", merchant.shopDomain);

  // Use Shopify REST Admin API to fetch products
  const session = {
    shop: merchant.shopDomain,
    accessToken: merchant.shopifyAccessToken,
  };
  const client = new shopify.api.clients.Rest({ session });
  console.log("[product-sync:fetchMerchantProducts] Shopify REST client created — shop=%s", merchant.shopDomain);

  const params = { limit };
  if (search) params.title = search;
  if (collection) params.collection_id = collection;
  console.log("[product-sync:fetchMerchantProducts] Fetching products from Shopify API — params=%s", JSON.stringify(params));

  const response = await client.get({ path: "products", query: params });
  const rawProductCount = response.body.products.length;
  console.log("[product-sync:fetchMerchantProducts] Shopify API response received — rawProductCount=%d", rawProductCount);

  const products = response.body.products.map((p) => ({
    id: String(p.id),
    title: p.title,
    handle: p.handle,
    imageUrl: p.image?.src || p.images?.[0]?.src || "",
    price: p.variants?.[0]?.price || "0.00",
    compareAtPrice: p.variants?.[0]?.compare_at_price,
    vendor: p.vendor,
    productType: p.product_type,
    url: `/products/${p.handle}`,
  }));

  const hasMore = products.length === limit;
  console.log("[product-sync:fetchMerchantProducts] <<< EXIT SUCCESS — merchantId=%s productsSynced=%d hasMore=%s (%dms)", merchantId, products.length, hasMore, Date.now() - _start);

  return { products, hasMore };
}

export async function fetchMerchantCollections(merchantId) {
  const _start = Date.now();
  console.log("[product-sync:fetchMerchantCollections] >>> ENTRY — merchantId=%s", merchantId);

  console.log("[product-sync:fetchMerchantCollections] Fetching merchant document from Firestore — merchantId=%s", merchantId);
  const merchantDoc = await db.collection("merchants").doc(merchantId).get();
  if (!merchantDoc.exists) {
    console.log("[product-sync:fetchMerchantCollections] <<< EXIT FAILED — merchant NOT FOUND — merchantId=%s (%dms)", merchantId, Date.now() - _start);
    throw new Error("Merchant not found");
  }
  const merchant = merchantDoc.data();
  console.log("[product-sync:fetchMerchantCollections] Merchant found — shopDomain=%s", merchant.shopDomain);

  const session = {
    shop: merchant.shopDomain,
    accessToken: merchant.shopifyAccessToken,
  };
  const client = new shopify.api.clients.Rest({ session });
  console.log("[product-sync:fetchMerchantCollections] Shopify REST client created — shop=%s", merchant.shopDomain);

  console.log("[product-sync:fetchMerchantCollections] Fetching custom_collections from Shopify API...");
  const response = await client.get({ path: "custom_collections" });
  const rawCollectionCount = response.body.custom_collections.length;
  console.log("[product-sync:fetchMerchantCollections] Shopify API response received — rawCollectionCount=%d", rawCollectionCount);

  const collections = response.body.custom_collections.map((c) => ({
    id: String(c.id),
    title: c.title,
    handle: c.handle,
    url: `/collections/${c.handle}`,
  }));

  console.log("[product-sync:fetchMerchantCollections] <<< EXIT SUCCESS — merchantId=%s collectionsFound=%d (%dms)", merchantId, collections.length, Date.now() - _start);
  return { collections };
}
