const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const QR_CODE_DIR = path.join(__dirname, '../uploads/qrcodes');

// Ensure directory exists
if (!fs.existsSync(QR_CODE_DIR)) {
  fs.mkdirSync(QR_CODE_DIR, { recursive: true });
}

/**
 * Generate QR code for an item
 * @param {string} itemId - The item ID to encode
 * @param {string} userId - The user ID for file organization
 * @returns {Promise<string>} - QR code file path
 */
const generateItemQRCode = async (itemId, userId) => {
  try {
    const userDir = path.join(QR_CODE_DIR, userId);
    
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const filename = `${itemId}.png`;
    const filePath = path.join(userDir, filename);
    const relativePath = `/uploads/qrcodes/${userId}/${filename}`;

    // Generate QR code containing only item ID
    await QRCode.toFile(filePath, itemId, {
      errorCorrectionLevel: 'H',
      type: 'image/png',
      width: 200,
      margin: 1,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    return relativePath;
  } catch (error) {
    throw new Error(`Failed to generate QR code: ${error.message}`);
  }
};

/**
 * Delete QR code file
 * @param {string} qrCodePath - The relative path to the QR code file
 */
const deleteItemQRCode = (qrCodePath) => {
  try {
    if (!qrCodePath) return;
    
    const filePath = path.join(__dirname, '..', qrCodePath);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (error) {
    console.error('Error deleting QR code:', error.message);
  }
};

/**
 * Regenerate QR code for item (delete old, create new)
 * @param {string} itemId - The item ID
 * @param {string} userId - The user ID
 * @param {string} oldQRCodePath - The old QR code path to delete
 * @returns {Promise<string>} - New QR code file path
 */
const regenerateItemQRCode = async (itemId, userId, oldQRCodePath) => {
  deleteItemQRCode(oldQRCodePath);
  return generateItemQRCode(itemId, userId);
};

module.exports = {
  generateItemQRCode,
  deleteItemQRCode,
  regenerateItemQRCode,
  QR_CODE_DIR
};
