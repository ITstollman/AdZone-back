import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { db } from "../../firebase.js";
import { z } from "zod";
import { createNotification } from "../../services/notification.js";

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1).max(100),
  merchantId: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

function issueToken(advertiserId, email) {
  return jwt.sign(
    { advertiserId, email },
    process.env.ADVERTISER_JWT_SECRET,
    { expiresIn: process.env.ADVERTISER_JWT_EXPIRY || "7d" }
  );
}

// POST /api/advertiser/auth/register
router.post("/register", async (req, res) => {
  try {
    const { email, password, name, merchantId } = registerSchema.parse(req.body);
    console.log("[auth.js:POST /register] Registration attempt", { email, name, merchantId });

    // Check if email already exists
    console.log("[auth.js:POST /register] Checking if email exists", { email });
    const existing = await db
      .collection("advertisers")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (!existing.empty) {
      console.log("[auth.js:POST /register] Email already registered, returning 409", { email });
      return res.status(409).json({ error: "Email already registered" });
    }

    // Verify merchant exists if provided
    const merchantIds = [];
    if (merchantId) {
      const merchantDoc = await db.collection("merchants").doc(merchantId).get();
      if (!merchantDoc.exists) {
        return res.status(400).json({ error: "Invalid merchant ID" });
      }
      merchantIds.push(merchantId);
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const advertiser = {
      email,
      passwordHash,
      name,
      merchantIds,
      status: "active",
      balance: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLoginAt: new Date(),
      invitedBy: merchantId || null,
    };

    console.log("[auth.js:POST /register] Creating advertiser record in DB", { email, name });
    const docRef = await db.collection("advertisers").add(advertiser);
    const token = issueToken(docRef.id, email);
    console.log("[auth.js:POST /register] Registration successful", { advertiserId: docRef.id, email });

    // Send welcome notification + email
    createNotification({
      recipientType: "advertiser",
      recipientId: docRef.id,
      type: "welcome",
      title: "Welcome to AdZone!",
      message: "Your advertiser account is ready. Create your first campaign to start reaching shoppers.",
      metadata: { name },
    }).catch((err) => console.error("Welcome notification error:", err.message));

    console.log("[auth.js:POST /register] Returning 201 with token", { advertiserId: docRef.id });
    res.status(201).json({
      token,
      advertiser: {
        id: docRef.id,
        email,
        name,
        merchantIds,
        status: "active",
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      console.log("[auth.js:POST /register] Validation failed", { errors: err.errors });
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error registering advertiser:", err);
    res.status(500).json({ error: "Registration failed" });
  }
});

// POST /api/advertiser/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = loginSchema.parse(req.body);
    console.log("[auth.js:POST /login] Login attempt", { email });

    console.log("[auth.js:POST /login] Looking up advertiser by email", { email });
    const snapshot = await db
      .collection("advertisers")
      .where("email", "==", email)
      .limit(1)
      .get();

    if (snapshot.empty) {
      console.log("[auth.js:POST /login] Login failed: email not found", { email });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    const doc = snapshot.docs[0];
    const advertiser = doc.data();

    const valid = await bcrypt.compare(password, advertiser.passwordHash);
    if (!valid) {
      console.log("[auth.js:POST /login] Login failed: invalid password", { email });
      return res.status(401).json({ error: "Invalid email or password" });
    }

    if (advertiser.status === "suspended") {
      console.log("[auth.js:POST /login] Login failed: account suspended", { email, advertiserId: doc.id });
      return res.status(403).json({ error: "Account suspended" });
    }

    // Update last login
    console.log("[auth.js:POST /login] Login successful, updating lastLoginAt", { advertiserId: doc.id, email });
    await doc.ref.update({ lastLoginAt: new Date() });

    const token = issueToken(doc.id, email);

    console.log("[auth.js:POST /login] Returning token (200)", { advertiserId: doc.id });
    res.json({
      token,
      advertiser: {
        id: doc.id,
        email: advertiser.email,
        name: advertiser.name,
        merchantIds: advertiser.merchantIds,
        status: advertiser.status,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: "Validation failed", details: err.errors });
    }
    console.error("Error logging in:", err);
    res.status(500).json({ error: "Login failed" });
  }
});

// POST /api/advertiser/auth/refresh
router.post("/refresh", async (req, res) => {
  console.log("[auth.js:POST /refresh] Token refresh attempt");
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    console.log("[auth.js:POST /refresh] No token provided, returning 401");
    return res.status(401).json({ error: "No token provided" });
  }

  try {
    const decoded = jwt.verify(authHeader.slice(7), process.env.ADVERTISER_JWT_SECRET);
    const token = issueToken(decoded.advertiserId, decoded.email);
    console.log("[auth.js:POST /refresh] Token refreshed successfully", { advertiserId: decoded.advertiserId });
    res.json({ token });
  } catch (err) {
    console.log("[auth.js:POST /refresh] Token refresh failed: invalid or expired token");
    res.status(401).json({ error: "Invalid or expired token" });
  }
});

export default router;
