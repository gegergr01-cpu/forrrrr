import { v2 as cloudinary } from 'cloudinary';

// Configure Cloudinary once centrally
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Base Cloudinary folder for this project.
 * Defaults to 'forhausgeraete' (customizable via CLOUDINARY_FOLDER env var)
 */
export const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'forhausgeraete';

export function getCloudinaryFolder(subfolder?: string): string {
  if (!subfolder) return CLOUDINARY_FOLDER;
  const cleanSub = subfolder.replace(/^\/+/, '');
  return `${CLOUDINARY_FOLDER}/${cleanSub}`;
}

export default cloudinary;
