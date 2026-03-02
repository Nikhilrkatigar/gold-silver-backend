const User = require('../models/User');

/**
 * Middleware: verify the authenticated user's stockMode is 'item'.
 * Previously duplicated in item.js and category.js route files.
 */
const checkItemMode = async (req, res, next) => {
    try {
        const user = await User.findById(req.userId);
        if (!user) {
            return res.status(404).json({ success: false, message: 'User not found' });
        }
        if (user.stockMode !== 'item') {
            return res.status(403).json({
                success: false,
                message: 'Item mode is not enabled for this user'
            });
        }
        req.user = user;
        next();
    } catch (error) {
        res.status(500).json({ success: false, message: 'Error verifying user mode' });
    }
};

module.exports = checkItemMode;
