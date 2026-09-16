import mongoose from 'mongoose';

const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true, minlength: 2, maxlength: 60 },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    role: { type: String, enum: ['employee', 'hr'], default: 'employee', required: true, index: true },
    passwordHash: { type: String, required: true, select: false }
  },
  { timestamps: true }
);

export const User = mongoose.model('User', userSchema);
