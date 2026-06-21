const cloudinary = require('cloudinary').v2;
require('dotenv').config();

// Configure cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || 'dineshsahoo',
  api_key: process.env.CLOUDINARY_API_KEY || '496258437561953',
  api_secret: process.env.CLOUDINARY_API_SECRET || 'eAbOECW5BncmCa5DWkP43IMQYZw'
});

/**
 * Uploads a base64 string or file buffer/path to Cloudinary.
 * @param {string} fileData - Base64 encoded file string (e.g. data:image/png;base64,...)
 * @returns {Promise<object>} Upload response from Cloudinary
 */
const uploadImage = async (fileData) => {
  try {
    const uploadResponse = await cloudinary.uploader.upload(fileData, {
      folder: 'code_clover_profiles',
      resource_type: 'image',
      allowed_formats: ['jpg', 'png', 'jpeg', 'webp', 'gif']
    });
    return uploadResponse;
  } catch (error) {
    console.error('❌ [Cloudinary] Upload failed:', error.message);
    throw error;
  }
};

module.exports = {
  cloudinary,
  uploadImage
};
