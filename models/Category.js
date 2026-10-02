const mongoose = require('mongoose');

const subCategorySchema = new mongoose.Schema({
    slug: { type: String, required: true, trim: true, lowercase: true },
    name: { type: String, required: true, trim: true }
}, { _id: true });

const categorySchema = new mongoose.Schema({
    slug: { type: String, required: true, unique: true, trim: true, lowercase: true, index: true },
    name: { type: String, required: true, trim: true },
    image: { type: String, trim: true }, // R2 key, e.g. "categories/tops.jpg"
    subCategories: [subCategorySchema]
}, {
    timestamps: true
});

categorySchema.pre('validate', function (next) {
    const slugs = this.subCategories.map((sub) => sub.slug);
    const duplicates = slugs.filter((slug, i) => slug && slugs.indexOf(slug) !== i);
    if (duplicates.length) {
        this.invalidate('subCategories', `Duplicate subcategory within category: ${[...new Set(duplicates)].join(', ')}`);
    }
    next();
});

module.exports = mongoose.model('Category', categorySchema);
