import { Storage } from "@google-cloud/storage";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";

const storage = new Storage();
const bucket = storage.bucket(process.env.GCS_BUCKET_NAME || "adzone-creatives");

// Standard ad dimensions for auto-resize
const AD_DIMENSIONS = {
  leaderboard: { width: 728, height: 90 },
  medium_rectangle: { width: 300, height: 250 },
  wide_skyscraper: { width: 160, height: 600 },
  mobile_banner: { width: 320, height: 50 },
  mobile_large: { width: 320, height: 100 },
};

const ALLOWED_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB

export function validateImage(file) {
  if (!file) throw new Error("No file provided");
  if (!ALLOWED_MIMES.includes(file.mimetype))
    throw new Error("Invalid image format. Allowed: JPEG, PNG, WebP, GIF");
  if (file.size > MAX_FILE_SIZE)
    throw new Error("Image too large. Maximum size is 5MB");
  return true;
}

export async function uploadCreativeImage(
  buffer,
  originalName,
  mimetype,
  advertiserId
) {
  const id = uuidv4();
  const ext = mimetype.split("/")[1] === "jpeg" ? "jpg" : mimetype.split("/")[1];

  // Upload original
  const originalPath = `creatives/${advertiserId}/${id}/original.${ext}`;
  const originalFile = bucket.file(originalPath);
  await originalFile.save(buffer, { contentType: mimetype, public: true });
  const originalUrl = `https://storage.googleapis.com/${bucket.name}/${originalPath}`;

  // Generate thumbnail (150x150 cover crop)
  const thumbnailBuffer = await sharp(buffer)
    .resize(150, 150, { fit: "cover" })
    .toFormat("webp")
    .toBuffer();
  const thumbnailPath = `creatives/${advertiserId}/${id}/thumbnail.webp`;
  const thumbnailFile = bucket.file(thumbnailPath);
  await thumbnailFile.save(thumbnailBuffer, {
    contentType: "image/webp",
    public: true,
  });
  const thumbnailUrl = `https://storage.googleapis.com/${bucket.name}/${thumbnailPath}`;

  // Generate resized versions for each standard ad dimension
  const resizedUrls = {};
  for (const [name, dims] of Object.entries(AD_DIMENSIONS)) {
    try {
      const resized = await sharp(buffer)
        .resize(dims.width, dims.height, {
          fit: "contain",
          background: { r: 255, g: 255, b: 255, alpha: 0 },
        })
        .toFormat("webp")
        .toBuffer();
      const resizedPath = `creatives/${advertiserId}/${id}/${name}.webp`;
      const resizedFile = bucket.file(resizedPath);
      await resizedFile.save(resized, {
        contentType: "image/webp",
        public: true,
      });
      resizedUrls[name] = `https://storage.googleapis.com/${bucket.name}/${resizedPath}`;
    } catch (err) {
      console.error(`Failed to resize to ${name}:`, err.message);
    }
  }

  return { originalUrl, thumbnailUrl, resizedUrls, fileId: id };
}

export async function deleteCreativeImages(advertiserId, fileId) {
  try {
    const [files] = await bucket.getFiles({
      prefix: `creatives/${advertiserId}/${fileId}/`,
    });
    await Promise.all(files.map((f) => f.delete()));
  } catch (err) {
    console.error("Error deleting creative images:", err.message);
  }
}
