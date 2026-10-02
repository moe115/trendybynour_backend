const mongoose = require('mongoose');

// Named monotonic counters (e.g. "productCode"), since Mongoose has no built-in auto-increment.
const counterSchema = new mongoose.Schema({
    _id: { type: String, required: true },
    seq: { type: Number, default: 0 }
});

counterSchema.statics.next = async function (name) {
    const counter = await this.findByIdAndUpdate(
        name,
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return counter.seq;
};

const Counter = mongoose.model('Counter', counterSchema);

const getNextProductCode = () => Counter.next('productCode');

module.exports = Counter;
module.exports.getNextProductCode = getNextProductCode;
