/**
 * Shared utility functions — single source of truth.
 *
 * Every route previously declared its own copies of toNumber, createError,
 * supportsTransactions, etc.  Centralising them here eliminates duplication
 * and ensures consistent behaviour across the application.
 */

const mongoose = require('mongoose');
const CONSTANTS = require('./constants');

// ───────────────────────── Number helpers ─────────────────────────

/**
 * Safely coerce a value to a finite number.
 * @param {*}      value     Value to coerce.
 * @param {number} [fallback=0] Fallback when the value is not a finite number.
 * @returns {number}
 */
const toNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
};

/**
 * Return the first finite number among the supplied values, or 0.
 */
const pickNumber = (...values) => {
    for (const value of values) {
        const n = Number(value);
        if (Number.isFinite(n)) return n;
    }
    return 0;
};

// ───────────────────────── Error helpers ──────────────────────────

/**
 * Build an Error with an HTTP status code and optional machine-readable code.
 */
const createError = (status, message, code) => {
    const error = new Error(message);
    error.status = status;
    if (code) error.code = code;
    return error;
};

const badRequest = (message) => createError(400, message);
const notFound = (message) => createError(404, message);

// ───────────────────────── Phone sanitizer ────────────────────────

const sanitizePhone = (phone) => String(phone || '').replace(/\D/g, '');

// ───────────────────────── Balance helpers ────────────────────────

const calculateUnifiedAmount = (balances) =>
    toNumber(balances.creditBalance) + toNumber(balances.cashBalance);

// ───────────────────────── Transaction helpers ───────────────────

/**
 * Check whether the current MongoDB topology supports multi-document
 * transactions (requires a replica-set or sharded cluster).
 */
const supportsTransactions = () => {
    const topologyType =
        mongoose.connection?.client?.topology?.description?.type;
    return Boolean(topologyType && topologyType !== 'Single');
};

/**
 * Start a session + transaction when the topology supports it.
 * Returns `null` on standalone / single-server deployments so callers
 * can safely pass `session` to Mongoose methods without branching.
 */
const startOptionalSession = async () => {
    if (!supportsTransactions()) return null;
    const session = await mongoose.startSession();
    session.startTransaction();
    return session;
};

// ───────────────────────── Reversal-window helpers ────────────────

const getReversalWindowHours = () => {
    const configured = toNumber(CONSTANTS.REVERSAL_POLICY?.WINDOW_HOURS, 48);
    return configured > 0 ? configured : 48;
};

/**
 * Generic time-window check — works for vouchers, settlements, karigar txns.
 * @param {Date|string} createdAt  The document's `createdAt` timestamp.
 * @returns {boolean}
 */
const canReverse = (createdAt) => {
    const referenceDate = createdAt ? new Date(createdAt) : null;
    const referenceTime = referenceDate?.getTime();
    if (!Number.isFinite(referenceTime)) return false;

    const elapsedMs = Date.now() - referenceTime;
    const allowedMs = getReversalWindowHours() * 60 * 60 * 1000;
    return elapsedMs <= allowedMs;
};

// ───────────────────────── Pagination helper ─────────────────────

/**
 * Parse pagination query params and return { page, limit, skip }.
 * Clamps limit to CONSTANTS.PAGINATION.MAX_LIMIT.
 */
const parsePagination = (query = {}) => {
    const page = Math.max(1, parseInt(query.page, 10) || CONSTANTS.PAGINATION.DEFAULT_PAGE);
    const limit = Math.min(
        parseInt(query.limit, 10) || CONSTANTS.PAGINATION.DEFAULT_LIMIT,
        CONSTANTS.PAGINATION.MAX_LIMIT
    );
    const skip = (page - 1) * limit;
    return { page, limit, skip };
};

/**
 * Build a standard pagination response object.
 */
const paginationMeta = (page, limit, total) => ({
    page,
    limit,
    total,
    pages: Math.ceil(total / limit)
});

// ─────────────────────────── Exports ─────────────────────────────

module.exports = {
    toNumber,
    pickNumber,
    createError,
    badRequest,
    notFound,
    sanitizePhone,
    calculateUnifiedAmount,
    supportsTransactions,
    startOptionalSession,
    getReversalWindowHours,
    canReverse,
    parsePagination,
    paginationMeta
};
