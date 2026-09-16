import mongoose from 'mongoose';

const ticketSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    customer: { type: String, required: true, trim: true, index: true },
    description: { type: String, default: '', trim: true },
    problemType: { type: String, enum: ['urgent', 'high', 'normal'], default: 'normal', index: true },
    assignee: { type: String, default: 'Priya', trim: true, index: true },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    status: { type: String, enum: ['open', 'in-progress', 'resolved'], default: 'open', index: true },
    responseDueAt: { type: Date, required: true, index: true },
    queueOrder: { type: Number, default: 0, index: true },
    lastEscalatedAt: { type: Date, default: null }
  },
  { timestamps: true }
);

export const Ticket = mongoose.model('Ticket', ticketSchema);
