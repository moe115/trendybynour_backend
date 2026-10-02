const mongoose = require('mongoose');

const variantSchema = new mongoose.Schema({
    sku: { type: String, required: true, trim: true }, // e.g. "TSHIRT-BLK-M" — human-assigned, not derived from productCode
    attributes: {
        color: { type: String, trim: true },
        size: { type: String, trim: true }
    },
    price: { type: Number }, // overrides product basePrice when set
    inventory: { type: Number, required: true, default: 0, min: 0 }
}, { _id: true });

const colorMediaSchema = new mongoose.Schema({
    color: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true }, // stable per-color letter ("a", "b", ...) used verbatim in R2 keys
    hexCode: { type: String, trim: true },
    mainImage: { type: String, trim: true }, // R2 key, e.g. "products/main/prod_9481-a.jpg"
    images: [{ type: String, required: true }] // R2 keys, e.g. "products/gallery/prod_9481-a/01.jpg"
}, { _id: false });

const productSchema = new mongoose.Schema({
    productCode: { type: Number, required: true, unique: true, index: true }, // auto-incrementing, used only in R2 keys
    title: { type: String, required: true, trim: true },
    category: { type: String, required: true, index: true },
    subCategory: { type: String, index: true },
    description: { type: String },
    basePrice: { type: Number, required: true, min: 0 },

    featuredImage: { type: String, trim: true }, // R2 key, product-level hero — required once visible (images upload after create)
    generalImages: [String], // R2 keys, "products/gallery/prod_9481/NN.jpg"
    colorMedia: [colorMediaSchema],

    hasVariants: { type: Boolean, default: false },
    inventory: { type: Number, default: 0, min: 0 },
    variants: [variantSchema],

    isFeatured: { type: Boolean, default: false },
    isVisible: { type: Boolean, default: true }
}, {
    timestamps: true
});

productSchema.index({ 'variants.sku': 1 });
productSchema.index({ category: 1, isVisible: 1 });

// "a".."z", then "aa", "ab", ... — the per-color letter used in R2 keys.
const colorCodeAt = (index) => {
    let code = '';
    for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
        code = String.fromCharCode(97 + ((n - 1) % 26)) + code;
    }
    return code;
};

productSchema.pre('validate', function (next) {
    // Assign missing colorMedia codes in insertion order, skipping letters already in use.
    const usedCodes = new Set(this.colorMedia.map((media) => media.code).filter(Boolean));
    let nextIndex = 0;
    for (const media of this.colorMedia) {
        if (media.code) continue;
        while (usedCodes.has(colorCodeAt(nextIndex))) nextIndex++;
        media.code = colorCodeAt(nextIndex);
        usedCodes.add(media.code);
    }

    const codes = this.colorMedia.map((media) => media.code);
    if (new Set(codes).size !== codes.length) {
        this.invalidate('colorMedia', 'Duplicate colorMedia code within product');
    }

    // SKUs must be unique within a product; the variants.sku index is lookup-only.
    const skus = this.variants.map((variant) => variant.sku);
    const duplicateSkus = skus.filter((sku, i) => sku && skus.indexOf(sku) !== i);
    if (duplicateSkus.length) {
        this.invalidate('variants', `Duplicate SKU within product: ${[...new Set(duplicateSkus)].join(', ')}`);
    }

    // Products are created hidden, images uploaded against their productCode, then made visible.
    if (this.isVisible && !this.featuredImage) {
        this.invalidate('featuredImage', 'featuredImage is required for a visible product');
    }

    if (this.hasVariants) {
        if (!this.variants.length) {
            this.invalidate('variants', 'hasVariants is true but variants is empty');
        }
        this.variants.forEach((variant, i) => {
            if (!variant.attributes?.color && !variant.attributes?.size) {
                this.invalidate(`variants.${i}.attributes`, 'Variant needs a color and/or size');
            }
        });
    } else if (this.variants.length) {
        this.invalidate('variants', 'hasVariants is false but variants is not empty');
    }

    next();
});

module.exports = mongoose.model('Product', productSchema);
