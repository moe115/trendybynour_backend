const {
    S3Client,
    ListObjectsV2Command,
    DeleteObjectsCommand,
    PutObjectCommand
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const REQUIRED_ENV = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];

const UPLOAD_URL_TTL_SECONDS = 300;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_EXTENSIONS = {
    'image/jpeg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/avif': 'avif'
};

let client;
const getClient = () => {
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]);
    if (missing.length) {
        throw new Error(`R2 is not configured: missing ${missing.join(', ')}`);
    }
    if (!client) {
        client = new S3Client({
            region: 'auto',
            endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
            credentials: {
                accessKeyId: process.env.R2_ACCESS_KEY_ID,
                secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
            },
            // Newer SDKs add CRC32 checksums by default; a presigned URL carrying one can't be satisfied by a browser PUT.
            requestChecksumCalculation: 'WHEN_REQUIRED',
            responseChecksumValidation: 'WHEN_REQUIRED'
        });
    }
    return client;
};

// "prod_9481" or "prod_9481-a" — the product/color token used in every key.
const keyToken = (productCode, colorCode) =>
    `prod_${productCode}${colorCode ? `-${colorCode}` : ''}`;

const mainImageKey = (productCode, colorCode, ext) =>
    `products/main/${keyToken(productCode, colorCode)}.${ext}`;

const galleryFolder = (productCode, colorCode) =>
    `products/gallery/${keyToken(productCode, colorCode)}`;

const galleryImageKey = (productCode, colorCode, seq, ext) =>
    `${galleryFolder(productCode, colorCode)}/${String(seq).padStart(2, '0')}.${ext}`;

// One image per category, e.g. "categories/tops.jpg" — re-uploading the same extension just overwrites it.
const categoryImageKey = (slug, ext) => `categories/${slug}.${ext}`;

// Signed with Content-Type and Content-Length, so the browser's PUT must match both exactly.
const createUploadUrl = (key, contentType, contentLength) =>
    getSignedUrl(
        getClient(),
        new PutObjectCommand({
            Bucket: process.env.R2_BUCKET,
            Key: key,
            ContentType: contentType,
            ContentLength: contentLength
        }),
        // The presigner leaves Content-Type unsigned by default; signing it stops a non-image being PUT under an image key.
        { expiresIn: UPLOAD_URL_TTL_SECONDS, signableHeaders: new Set(['content-type']) }
    );

const listKeys = async (prefix) => {
    const keys = [];
    let ContinuationToken;
    do {
        const page = await getClient().send(new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET,
            Prefix: prefix,
            ContinuationToken
        }));
        (page.Contents || []).forEach((object) => keys.push(object.Key));
        ContinuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (ContinuationToken);
    return keys;
};

// Every prefix ends in a delimiter right after the code, so prod_9481 never matches prod_94811.
const productImagePrefixes = (productCode) => [
    `products/main/prod_${productCode}.`,
    `products/main/prod_${productCode}-`,
    `products/gallery/prod_${productCode}/`,
    `products/gallery/prod_${productCode}-`
];

// True when key is one of this product's image keys (main or gallery, any color).
const isProductImageKey = (productCode, key) =>
    typeof key === 'string' && productImagePrefixes(productCode).some((prefix) => key.startsWith(prefix));

// Removes the given keys in DeleteObjects batches of up to 1000.
const deleteKeys = async (keys) => {
    for (let i = 0; i < keys.length; i += 1000) {
        const result = await getClient().send(new DeleteObjectsCommand({
            Bucket: process.env.R2_BUCKET,
            Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true }
        }));
        if (result.Errors && result.Errors.length) {
            throw new Error(`Failed to delete ${result.Errors.length} image(s), e.g. ${result.Errors[0].Key}: ${result.Errors[0].Message}`);
        }
    }
    return keys;
};

// Lists all of a product's images and removes them in DeleteObjects batches of up to 1000.
const deleteProductImages = async (productCode) => {
    const keyLists = await Promise.all(productImagePrefixes(productCode).map(listKeys));
    return deleteKeys(keyLists.flat());
};

module.exports = {
    IMAGE_EXTENSIONS,
    MAX_IMAGE_BYTES,
    UPLOAD_URL_TTL_SECONDS,
    mainImageKey,
    galleryFolder,
    galleryImageKey,
    categoryImageKey,
    createUploadUrl,
    isProductImageKey,
    deleteKeys,
    deleteProductImages
};
