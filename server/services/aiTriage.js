import OpenAI from 'openai';
import { getTicketSignals } from './queueScore.js';

const TRIAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ranking: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string' },
          score: { type: 'integer', minimum: 0, maximum: 100 },
          reason: { type: 'string', maxLength: 120 }
        },
        required: ['id', 'score', 'reason']
      }
    }
  },
  required: ['ranking']
};

function configuredModel() {
  return process.env.OPENAI_MODEL || 'gpt-5-mini';
}

export function aiStatus() {
  return {
    enabled: Boolean(process.env.OPENAI_API_KEY),
    provider: process.env.OPENAI_API_KEY ? 'OpenAI' : 'Smart rules',
    model: process.env.OPENAI_API_KEY ? configuredModel() : null
  };
}

export async function rankWithOpenAI(tickets) {
  if (!process.env.OPENAI_API_KEY || tickets.length < 2) {
    return { tickets, ...aiStatus(), fallback: true };
  }

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const candidates = tickets.map((ticket) => ({
    id: String(ticket._id),
    title: ticket.title,
    description: ticket.description || '',
    problemType: ticket.problemType,
    status: ticket.status,
    responseDueAt: ticket.responseDueAt,
    minutesLeft: getTicketSignals(ticket).minutesLeft
  }));

  try {
    const response = await client.responses.create({
      model: configuredModel(),
      input: [
        {
          role: 'system',
          content: 'You rank IT helpdesk tickets for a small support team. Higher score means handle sooner. Consider the stated type, time remaining, scope of work stoppage, client deadlines, security risk, and whether a user is blocked. Use only supplied facts. Return every supplied id exactly once. Do not put any overdue ticket below a non-overdue ticket.'
        },
        {
          role: 'user',
          content: `Rank these tickets. Current data: ${JSON.stringify(candidates)}`
        }
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'helpdesk_ticket_ranking',
          strict: true,
          schema: TRIAGE_SCHEMA
        }
      }
    });
    const parsed = JSON.parse(response.output_text);
    const scoreById = new Map(parsed.ranking.map((item) => [item.id, item.score]));
    if (scoreById.size !== tickets.length || tickets.some((ticket) => !scoreById.has(String(ticket._id)))) {
      throw new Error('AI response did not include a complete ticket ranking.');
    }

    const ordered = [...tickets].sort((a, b) => {
      const aSignals = getTicketSignals(a);
      const bSignals = getTicketSignals(b);
      if (aSignals.isOverdue !== bSignals.isOverdue) return aSignals.isOverdue ? -1 : 1;
      return scoreById.get(String(b._id)) - scoreById.get(String(a._id)) || aSignals.minutesLeft - bSignals.minutesLeft;
    });

    return { tickets: ordered, enabled: true, provider: 'OpenAI', model: configuredModel(), fallback: false };
  } catch (error) {
    console.warn(`OpenAI triage unavailable; using smart rules. ${error.message}`);
    return { tickets, enabled: false, provider: 'Smart rules', model: null, fallback: true, warning: 'AI triage is temporarily unavailable, so smart-rule ordering is being used.' };
  }
}
