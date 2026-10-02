// One-off: creates the 5 main categories (if missing) with a starter set of subcategories.
// Run from /backend: node scripts/seedCategories.js
// Safe to re-run — existing categories (matched by slug) are left untouched, including any
// subcategories the admin has since added or removed.
require('dotenv').config({ path: require('path').join(__dirname, '..', 'var', '.env') });
const mongoose = require('mongoose');
const Category = require('../models/Category');
const { slugify } = require('../lib/slugify');

const withSlugs = (names) => names.map((name) => ({ name, slug: slugify(name) }));

const MAIN_CATEGORIES = [
    { name: 'Tops', slug: 'tops', subCategories: withSlugs(['Hoodies', 'T-Shirts', 'Blouses', 'Sweatshirts']) },
    { name: 'Bottoms', slug: 'bottoms', subCategories: withSlugs(['Jeans', 'Trousers', 'Skirts']) },
    { name: 'Hijab', slug: 'hijab', subCategories: withSlugs(['Shawl', 'Under Cap', 'Accessories']) },
    { name: 'Accessories', slug: 'accessories', subCategories: withSlugs(['Rings', 'Bags', 'Bracelets', 'Necklaces']) },
    { name: 'Full Outfit', slug: 'full-outfit', subCategories: withSlugs(['Sets', 'Full Look', 'Dresses']) }
];

const run = async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    for (const category of MAIN_CATEGORIES) {
        const existing = await Category.findOne({ slug: category.slug });
        if (existing) {
            console.log(`Skipping "${category.slug}" — already exists`);
            continue;
        }
        await Category.create(category);
        console.log(`Created "${category.slug}"`);
    }
    await mongoose.disconnect();
};

run().catch((error) => {
    console.error('Seeding categories failed:', error);
    process.exit(1);
});
