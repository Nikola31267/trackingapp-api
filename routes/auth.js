import express from "express";
import User from "../models/User.js";
const router = express.Router();
import jwt from "jsonwebtoken";
import { verifyToken } from "../middleware/auth.js";
import axios from "axios";
import multer from "multer";
import cloudinary from "../config/cloudinary.js";
import { Resend } from "resend";
import crypto from "crypto";
import dotenv from "dotenv";
import Visit from "../models/Visit.js";

dotenv.config();

const resend = new Resend(process.env.RESEND_API_KEY);
const storage = multer.memoryStorage();
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

router.get("/user", verifyToken, async (req, res) => {
  const user = await User.findById(req.user.id);
  res.status(200).json(user);
});

router.put(
  "/updateProfile",
  verifyToken,
  upload.single("profilePicture"),
  async (req, res) => {
    try {
      const { username, email, fullName } = req.body;
      const user = await User.findById(req.user.id);

      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      if (username) {
        const existingUsername = await User.findOne({ username });
        if (
          existingUsername &&
          existingUsername._id.toString() !== user._id.toString()
        ) {
          return res.status(400).json({ message: "Username already exists" });
        }
      }

      if (email) {
        const existingEmail = await User.findOne({ email });
        if (
          existingEmail &&
          existingEmail._id.toString() !== user._id.toString()
        ) {
          return res.status(400).json({ message: "Email already exists" });
        }
      }

      if (req.file) {
        if (user.profilePicture) {
          const publicId = user.profilePicture
            .split("/")
            .slice(-1)[0]
            .split(".")[0];
          await cloudinary.uploader.destroy(`profile_pictures/${publicId}`);
        }

        const result = await new Promise((resolve, reject) => {
          cloudinary.uploader
            .upload_stream(
              { folder: "profile_pictures_website" },
              (error, result) => {
                if (error) return reject(error);
                resolve(result);
              }
            )
            .end(req.file.buffer);
        });

        user.profilePicture = result.secure_url;
      }

      if (username) user.username = username;
      if (email) user.email = email;
      if (fullName) user.fullName = fullName;

      await user.save();
      return res.status(200).json(user);
    } catch (err) {
      console.error(err);
      res.status(500).json({ message: "Server error", error: err.message });
    }
  }
);

router.put("/deleteProfilePicture", verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (user.profilePicture) {
      const publicId = user.profilePicture
        .split("/")
        .slice(-1)[0]
        .split(".")[0];
      await cloudinary.uploader.destroy(`profile_pictures_website/${publicId}`);
      user.profilePicture = "";
    }

    await user.save();
    res.status(200).json({ message: "Profile picture deleted successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.post("/magic-link", async (req, res) => {
  const { email } = req.body;

  try {
    const magicLinkToken = crypto.randomBytes(32).toString("hex");
    const magicLinkExpiresAt = new Date(Date.now() + 15 * 60 * 1000);

    let user = await User.findOne({ email });

    if (!user) {
      user = new User({
        email,
        username: email.split("@")[0],
        magicLinkToken,
        magicLinkExpiresAt,
      });
    } else {
      user.magicLinkToken = magicLinkToken;
      user.magicLinkExpiresAt = magicLinkExpiresAt;
    }

    await user.save();

    await (async function () {
      const { data, error } = await resend.emails.send({
        from: "TrackingApp <no-reply@startgrid.xyz>",
        to: [email],
        subject: "Verify your email",
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
            <h1 style="color: #333; text-align: center;">Verify Your Email Address</h1>
            <p style="font-size: 16px; color: #333;">Hello ${email},</p>
            <p style="font-size: 16px; color: #333;">Thank you for signing up. Please click the link below to verify your email address:</p>
            
            <div style="text-align: center; margin-top: 20px;">
              <a href="${process.env.WEBSITE_URL}/verify-magic-link?token=${magicLinkToken}" style="text-decoration: none; padding: 10px 20px; background-color: #333; color: #fff; border-radius: 4px;" target="_blank">Verify Email</a>
            </div>
  
          </div>
        `,
      });

      if (error) {
        return console.error({ error });
      }

      console.log({ data });
    })();

    res.status(200).json({
      message: "Link sent successfully. Please check your email.",
    });
  } catch (error) {
    console.error("Magic link error:", error);
    res.status(500).json({
      message: "Error sending magic link",
      error: error.message,
    });
  }
});

router.post("/verify-magic-link", async (req, res) => {
  const { token } = req.body;

  try {
    const user = await User.findOne({
      magicLinkToken: token,
      magicLinkExpiresAt: { $gt: Date.now() },
    });

    if (!user) {
      return res.status(400).json({
        message: "Invalid or expired magic link",
      });
    }

    user.magicLinkToken = "";
    user.magicLinkExpiresAt = null;
    user.isEmailVerified = true;
    await user.save();

    const jwtToken = jwt.sign(
      { id: user._id, email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.status(200).json({
      message: "Email verified successfully",
      token: jwtToken,
    });
  } catch (error) {
    console.error("Verification error:", error);
    res.status(500).json({
      message: "Error verifying magic link",
      error: error.message,
    });
  }
});

router.delete("/delete-account", verifyToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await Visit.deleteMany({ creator: user._id });
    await user.deleteOne();
    res
      .status(200)
      .json({ message: "Account and associated visits deleted successfully" });
  } catch (error) {
    console.error("Error deleting account:", error);
    res.status(500).json({ message: "Server error" });
  }
});
export default router;
