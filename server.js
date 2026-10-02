const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config({ path: require('path').join(__dirname, 'var', '.env') });
const Product = require('./models/Product');
const Category = require('./models/Category');
const Counter = require('./models/Counter');
const { getNextProductCode } = Counter;
const r2 = require('./lib/r2');
const { slugify } = require('./lib/slugify');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
.then(() => console.log('MongoDB connected successfully'))
.catch((err) => console.error('MongoDB connection error:', err));

// Routes

// Fields the server owns; never taken from a request body.
const PROTECTED_FIELDS = ['_id', 'productCode', 'createdAt', 'updatedAt'];

const stripProtectedFields = (body) => {
    const clean = { ...body };
    PROTECTED_FIELDS.forEach((field) => delete clean[field]);
    return clean;
};

// Validation and bad-id errors are the client's fault (400); a unique-index clash is a conflict (409).
const sendError = (res, error, context) => {
    if (error.name === 'ValidationError' || error.name === 'CastError') {
        return res.status(400).json({ success: false, error: error.message });
    }
    if (error.code === 11000) {
        return res.status(409).json({ success: false, error: error.message });
    }
    console.error(`Error ${context}:`, error);
    res.status(500).json({ success: false, error: error.message });
};

// Create a new product
app.post('/api/products', async (req, res) => {
    try {
        const product = new Product(stripProtectedFields(req.body));
        await product.validate({ pathsToSkip: ['productCode'] }); // fail before consuming a productCode
        product.productCode = await getNextProductCode();
        await product.save();
        res.status(201).json({ success: true, data: product });
    } catch (error) {
        sendError(res, error, 'creating product');
    }
});

// Get products — optional filters: ?category=&subCategory=&isVisible=true|false&isFeatured=true|false
app.get('/api/products', async (req, res) => {
    try {
        const filter = {};
        ['category', 'subCategory'].forEach((field) => {
            if (typeof req.query[field] === 'string' && req.query[field]) filter[field] = req.query[field];
        });
        ['isVisible', 'isFeatured'].forEach((field) => {
            if (req.query[field] === 'true' || req.query[field] === 'false') filter[field] = req.query[field] === 'true';
        });
        const products = await Product.find(filter).sort({ createdAt: -1 });
        res.json({ success: true, data: products });
    } catch (error) {
        sendError(res, error, 'fetching products');
    }
});

// Get products by category
app.get('/api/products/category/:category', async (req, res) => {
    try {
        const products = await Product.find({
            category: req.params.category,
            isVisible: true
        }).sort({ createdAt: -1 });
        res.json({ success: true, data: products });
    } catch (error) {
        sendError(res, error, 'fetching products by category');
    }
});

// Get featured products
app.get('/api/products/featured/all', async (req, res) => {
    try {
        const products = await Product.find({
            isFeatured: true,
            isVisible: true
        }).sort({ createdAt: -1 });
        res.json({ success: true, data: products });
    } catch (error) {
        sendError(res, error, 'fetching featured products');
    }
});

// Get products containing a variant SKU (SKUs are unique per product, not globally)
app.get('/api/products/sku/:sku', async (req, res) => {
    try {
        const products = await Product.find({ 'variants.sku': req.params.sku });
        if (!products.length) {
            return res.status(404).json({ success: false, error: 'No product with that SKU' });
        }
        const data = products.map((product) => ({
            product,
            variant: product.variants.find((variant) => variant.sku === req.params.sku)
        }));
        res.json({ success: true, data });
    } catch (error) {
        sendError(res, error, 'fetching product by SKU');
    }
});

// Get a single product by productCode
app.get('/api/products/code/:productCode', async (req, res) => {
    try {
        const productCode = Number(req.params.productCode);
        if (!Number.isInteger(productCode)) {
            return res.status(400).json({ success: false, error: 'productCode must be an integer' });
        }
        const product = await Product.findOne({ productCode });
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        res.json({ success: true, data: product });
    } catch (error) {
        sendError(res, error, 'fetching product by code');
    }
});

// Get a single product by ID
app.get('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        res.json({ success: true, data: product });
    } catch (error) {
        sendError(res, error, 'fetching product');
    }
});

// Update a product
app.put('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }

        const update = stripProtectedFields(req.body);
        // Keep each existing color's code (it's baked into R2 keys) when the client omits it.
        if (Array.isArray(update.colorMedia)) {
            const existingCodes = new Map(product.colorMedia.map((media) => [media.color, media.code]));
            update.colorMedia = update.colorMedia.map((media) => ({
                ...media,
                code: media.code || existingCodes.get(media.color)
            }));
        }

        const keysBefore = referencedImageKeys(product);
        product.set(update);
        await product.save(); // full-document validation, timestamps update automatically

        // Images the update dropped are deleted from R2. Only this product's own keys, and only after the save
        // succeeded; a storage failure here just leaves orphans, so it doesn't fail the request.
        const keysAfter = referencedImageKeys(product);
        const removedKeys = [...keysBefore].filter((key) => !keysAfter.has(key) && r2.isProductImageKey(product.productCode, key));
        let deletedImages = 0;
        if (removedKeys.length) {
            try {
                deletedImages = (await r2.deleteKeys(removedKeys)).length;
            } catch (error) {
                console.error(`Error deleting removed images of product ${product.productCode}:`, error);
            }
        }
        res.json({ success: true, data: product, deletedImages });
    } catch (error) {
        sendError(res, error, 'updating product');
    }
});

// Delete a product and its R2 images (images first, so a storage failure leaves the product retryable)
app.delete('/api/products/:id', async (req, res) => {
    try {
        const product = await Product.findById(req.params.id);
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }
        const deletedImages = await r2.deleteProductImages(product.productCode);
        await product.deleteOne();
        res.json({ success: true, message: 'Product deleted successfully', deletedImages: deletedImages.length });
    } catch (error) {
        sendError(res, error, 'deleting product');
    }
});

// Every R2 key a product document references (featured, general and per-color images).
const referencedImageKeys = (product) => new Set([
    product.featuredImage,
    ...(product.generalImages || []),
    ...(product.colorMedia || []).flatMap((media) => [media.mainImage, ...(media.images || [])])
].filter(Boolean));

const parseProductCode = (value) => {
    const productCode = Number(value);
    return Number.isInteger(productCode) && productCode > 0 ? productCode : null;
};

// Presigned URL for the browser to PUT one image straight to R2.
// Body: { role: 'main'|'gallery', color?, contentType, size } — color must already be in the product's colorMedia.
app.post('/api/products/:productCode/images/upload-url', async (req, res) => {
    try {
        const productCode = parseProductCode(req.params.productCode);
        if (!productCode) {
            return res.status(400).json({ success: false, error: 'productCode must be a positive integer' });
        }

        const { role, color, contentType, size } = req.body;
        if (!['main', 'gallery'].includes(role)) {
            return res.status(400).json({ success: false, error: "role must be 'main' or 'gallery'" });
        }
        const ext = r2.IMAGE_EXTENSIONS[contentType];
        if (!ext) {
            return res.status(400).json({ success: false, error: `contentType must be one of: ${Object.keys(r2.IMAGE_EXTENSIONS).join(', ')}` });
        }
        if (!Number.isInteger(size) || size <= 0 || size > r2.MAX_IMAGE_BYTES) {
            return res.status(400).json({ success: false, error: `size must be an integer byte count up to ${r2.MAX_IMAGE_BYTES}` });
        }

        const product = await Product.findOne({ productCode });
        if (!product) {
            return res.status(404).json({ success: false, error: 'Product not found' });
        }

        let colorCode;
        if (color) {
            const media = product.colorMedia.find((entry) => entry.color === color);
            if (!media) {
                return res.status(400).json({ success: false, error: `Color "${color}" is not in this product's colorMedia — add it via create/update first` });
            }
            colorCode = media.code;
        }

        let key;
        if (role === 'main') {
            key = r2.mainImageKey(productCode, colorCode, ext);
        } else {
            // Atomic per-folder counter: concurrent uploads never share a number, and numbers are never reused.
            const seq = await Counter.next(`gallery:${r2.galleryFolder(productCode, colorCode)}`);
            key = r2.galleryImageKey(productCode, colorCode, seq, ext);
        }

        const uploadUrl = await r2.createUploadUrl(key, contentType, size);
        res.json({
            success: true,
            data: {
                key,
                uploadUrl,
                method: 'PUT',
                headers: { 'Content-Type': contentType },
                expiresIn: r2.UPLOAD_URL_TTL_SECONDS
            }
        });
    } catch (error) {
        sendError(res, error, 'creating upload URL');
    }
});

// Remove every R2 image for a product (also run by the product-delete route).
app.delete('/api/products/:productCode/images', async (req, res) => {
    try {
        const productCode = parseProductCode(req.params.productCode);
        if (!productCode) {
            return res.status(400).json({ success: false, error: 'productCode must be a positive integer' });
        }
        const deletedKeys = await r2.deleteProductImages(productCode);
        res.json({ success: true, data: { deleted: deletedKeys.length, keys: deletedKeys } });
    } catch (error) {
        sendError(res, error, 'deleting product images');
    }
});

// Remove specific uploaded images — used to clean up uploads when an edit fails before they're saved.
// Body: { keys: string[] }. Keys must belong to this product; keys it still references are skipped, not deleted.
app.post('/api/products/:productCode/images/delete', async (req, res) => {
    try {
        const productCode = parseProductCode(req.params.productCode);
        if (!productCode) {
            return res.status(400).json({ success: false, error: 'productCode must be a positive integer' });
        }
        const { keys } = req.body;
        if (!Array.isArray(keys) || !keys.length) {
            return res.status(400).json({ success: false, error: 'keys must be a non-empty array' });
        }
        const foreign = keys.filter((key) => !r2.isProductImageKey(productCode, key));
        if (foreign.length) {
            return res.status(400).json({ success: false, error: `Not images of product ${productCode}: ${foreign.join(', ')}` });
        }
        const product = await Product.findOne({ productCode });
        const referenced = product ? referencedImageKeys(product) : new Set();
        const unique = [...new Set(keys)];
        const skipped = unique.filter((key) => referenced.has(key));
        const deletedKeys = await r2.deleteKeys(unique.filter((key) => !referenced.has(key)));
        res.json({ success: true, data: { deleted: deletedKeys.length, keys: deletedKeys, skipped } });
    } catch (error) {
        sendError(res, error, 'deleting images');
    }
});

// ----- Categories -----
// Fixed set of main categories (tops, bottoms, hijab, accessories, full-outfit — see backend/scripts/seedCategories.js),
// each owning its own subcategories and a single R2 header image. No auth yet, same as the products API above.

// List all categories with their subcategories — storefront filters/nav and admin management both read this.
app.get('/api/categories', async (req, res) => {
    try {
        const categories = await Category.find().sort({ createdAt: 1 });
        res.json({ success: true, data: categories });
    } catch (error) {
        sendError(res, error, 'fetching categories');
    }
});

app.get('/api/categories/:id', async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) {
            return res.status(404).json({ success: false, error: 'Category not found' });
        }
        res.json({ success: true, data: category });
    } catch (error) {
        sendError(res, error, 'fetching category');
    }
});

// Create a main category. slug is derived from name when not given.
app.post('/api/categories', async (req, res) => {
    try {
        const { name, slug, image } = req.body;
        const category = new Category({ name, slug: slug || slugify(name || ''), image });
        await category.save();
        res.status(201).json({ success: true, data: category });
    } catch (error) {
        sendError(res, error, 'creating category');
    }
});

// Update a category's name/image. image is a key obtained from the upload-url route below;
// subCategories are managed only via the dedicated routes further down.
app.put('/api/categories/:id', async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) {
            return res.status(404).json({ success: false, error: 'Category not found' });
        }

        const previousImage = category.image;
        const update = stripProtectedFields(req.body);
        delete update.subCategories;
        category.set(update);
        await category.save();

        // The old image is orphaned once the field points elsewhere; best-effort cleanup, doesn't fail the request.
        if (previousImage && previousImage !== category.image) {
            try {
                await r2.deleteKeys([previousImage]);
            } catch (error) {
                console.error(`Error deleting old image for category ${category.slug}:`, error);
            }
        }
        res.json({ success: true, data: category });
    } catch (error) {
        sendError(res, error, 'updating category');
    }
});

// Delete a category and its R2 image.
app.delete('/api/categories/:id', async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) {
            return res.status(404).json({ success: false, error: 'Category not found' });
        }
        if (category.image) {
            try {
                await r2.deleteKeys([category.image]);
            } catch (error) {
                console.error(`Error deleting image for category ${category.slug}:`, error);
            }
        }
        await category.deleteOne();
        res.json({ success: true, message: 'Category deleted successfully' });
    } catch (error) {
        sendError(res, error, 'deleting category');
    }
});

// Presigned URL for the browser to PUT a new header image straight to R2.
// Body: { contentType, size }. Caller must then PUT /api/categories/:id with { image: key } to save it.
app.post('/api/categories/:id/image/upload-url', async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) {
            return res.status(404).json({ success: false, error: 'Category not found' });
        }

        const { contentType, size } = req.body;
        const ext = r2.IMAGE_EXTENSIONS[contentType];
        if (!ext) {
            return res.status(400).json({ success: false, error: `contentType must be one of: ${Object.keys(r2.IMAGE_EXTENSIONS).join(', ')}` });
        }
        if (!Number.isInteger(size) || size <= 0 || size > r2.MAX_IMAGE_BYTES) {
            return res.status(400).json({ success: false, error: `size must be an integer byte count up to ${r2.MAX_IMAGE_BYTES}` });
        }

        const key = r2.categoryImageKey(category.slug, ext);
        const uploadUrl = await r2.createUploadUrl(key, contentType, size);
        res.json({
            success: true,
            data: {
                key,
                uploadUrl,
                method: 'PUT',
                headers: { 'Content-Type': contentType },
                expiresIn: r2.UPLOAD_URL_TTL_SECONDS
            }
        });
    } catch (error) {
        sendError(res, error, 'creating category image upload URL');
    }
});

// Add a subcategory. Body: { name, slug? }.
app.post('/api/categories/:id/subcategories', async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) {
            return res.status(404).json({ success: false, error: 'Category not found' });
        }
        const { name, slug } = req.body;
        if (!name) {
            return res.status(400).json({ success: false, error: 'name is required' });
        }
        category.subCategories.push({ name, slug: slug || slugify(name) });
        await category.save();
        res.status(201).json({ success: true, data: category });
    } catch (error) {
        sendError(res, error, 'adding subcategory');
    }
});

// Remove a subcategory.
app.delete('/api/categories/:id/subcategories/:subId', async (req, res) => {
    try {
        const category = await Category.findById(req.params.id);
        if (!category) {
            return res.status(404).json({ success: false, error: 'Category not found' });
        }
        const subCategory = category.subCategories.id(req.params.subId);
        if (!subCategory) {
            return res.status(404).json({ success: false, error: 'Subcategory not found' });
        }
        subCategory.deleteOne();
        await category.save();
        res.json({ success: true, data: category });
    } catch (error) {
        sendError(res, error, 'removing subcategory');
    }
});

const PORT = process.env.PORT || 5050; // not 5000: macOS AirPlay Receiver listens there
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});