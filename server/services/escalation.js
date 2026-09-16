import { Ticket } from '../models/Ticket.js';

export const PRIORITY_STEPS = { normal: 'high', high: 'urgent', urgent: null };

export function nextPriority(problemType) {
  return PRIORITY_STEPS[problemType] || null;
}

let isChecking = false;

export async function runEscalationCheck(onEscalated) {
  if (isChecking) return [];
  isChecking = true;
  try {
    const now = new Date();
    const breachedTickets = await Ticket.find({
      status: { $ne: 'resolved' },
      responseDueAt: { $lt: now },
      problemType: { $in: ['normal', 'high'] }
    }).lean();

    const updates = await Promise.all(breachedTickets.map(async (ticket) => {
      const next = nextPriority(ticket.problemType);
      const updated = await Ticket.findOneAndUpdate(
        {
          _id: ticket._id,
          problemType: ticket.problemType,
          status: { $ne: 'resolved' },
          responseDueAt: { $lt: now }
        },
        { $set: { problemType: next, lastEscalatedAt: now } },
        { new: true }
      ).lean();
      if (updated) onEscalated(updated, ticket.problemType);
      return updated;
    }));

    return updates.filter(Boolean);
  } finally {
    isChecking = false;
  }
}
